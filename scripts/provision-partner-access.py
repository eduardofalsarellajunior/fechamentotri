#!/usr/bin/env python3
"""Provision explicitly supplied partner emails; preserve passwords of existing users."""
import argparse
import json
import os
from pathlib import Path
import tempfile
import urllib.error
import urllib.parse
import urllib.request

INITIAL_PASSWORD = 'inepad123'


def request(endpoint, method='GET', data=None):
    headers = {'apikey': os.environ['SUPABASE_SERVICE_ROLE_KEY'],
               'Authorization': 'Bearer ' + os.environ['SUPABASE_SERVICE_ROLE_KEY'],
               'Content-Type': 'application/json'}
    req = urllib.request.Request(os.environ['SUPABASE_URL'].rstrip('/') + endpoint, headers=headers,
                                 method=method, data=None if data is None else json.dumps(data).encode())
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)


def all_users():
    users = []
    page = 1
    while True:
        data = request('/auth/v1/admin/users?page=' + str(page) + '&per_page=200')['users']
        users.extend(data)
        if len(data) < 200:
            return users
        page += 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', required=True, help='JSON with admin_email and partner_id -> email mappings')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    manifest = json.loads(Path(args.manifest).read_text())
    administrator = manifest['admin_email'].strip().lower()
    partners = request('/rest/v1/partners?select=id,name&order=id.asc')
    users = all_users()
    mappings = manifest['partners']
    if set(mappings) != {p['id'] for p in partners}:
        raise ValueError('The manifest must explicitly include every registered partner exactly once.')
    if len({v.strip().lower() for v in mappings.values()}) != len(mappings):
        raise ValueError('Each partner must have a distinct login email.')
    plan = []
    for partner in partners:
        email = mappings[partner['id']].strip().lower()
        if '@' not in email or '.' not in email.split('@')[-1]:
            raise ValueError('Invalid email supplied for ' + partner['name'])
        linked = next((u for u in users if u.get('app_metadata', {}).get('partner_id') == partner['id']), None)
        matching = next((u for u in users if u.get('email', '').lower() == email), None)
        if linked and matching and linked['id'] != matching['id']:
            raise ValueError('Conflicting accounts for ' + partner['name'])
        account = linked or matching
        if account and account.get('app_metadata', {}).get('partner_id') not in (None, partner['id']):
            raise ValueError('Email already associated with a different partner.')
        if account and account['email'].lower() != email:
            raise ValueError('Existing account email differs; handle as an explicit email edit in the application.')
        if email == administrator and not account:
            raise ValueError('Administrator must already have a personal login; never create a default-password admin.')
        plan.append((partner, email, account))
    print(json.dumps([{'name': p['name'], 'email': email, 'action': 'link_existing_preserve_password' if account else 'create_read_only_with_first_password_change'} for p, email, account in plan], ensure_ascii=False, indent=2))
    if not args.apply:
        print('DRY RUN: no users changed.')
        return
    backup_dir = Path(tempfile.mkdtemp(prefix='inepad-access-backup-'))
    backup = backup_dir / 'original-access-metadata.json'
    backup.write_text(json.dumps([{'id': a['id'], 'email': a['email'], 'app_metadata': a.get('app_metadata', {}), 'user_metadata': a.get('user_metadata', {})} for _, _, a in plan if a], ensure_ascii=False, indent=2))
    backup.chmod(0o600)
    created = []
    for partner, email, account in plan:
        if account:
            metadata = {**account.get('app_metadata', {}), 'partner_id': partner['id']}
            if email == administrator:
                metadata['must_change_password'] = False
            body = {'app_metadata': metadata, 'user_metadata': {**account.get('user_metadata', {}), 'full_name': partner['name']}}
            result = request('/auth/v1/admin/users/' + urllib.parse.quote(account['id']), 'PUT', body)
        else:
            result = request('/auth/v1/admin/users', 'POST', {
                'email': email, 'password': INITIAL_PASSWORD, 'email_confirm': True,
                'app_metadata': {'partner_id': partner['id'], 'must_change_password': True},
                'user_metadata': {'full_name': partner['name']},
            })
        result = result.get('user', result)
        if not account:
            created.append(result['id'])
            (backup_dir / 'created-account-ids.json').write_text(json.dumps(created))
        check = request('/auth/v1/admin/users/' + urllib.parse.quote(result['id']))
        check = check.get('user', check)
        if check.get('email', '').lower() != email or check.get('app_metadata', {}).get('partner_id') != partner['id']:
            raise ValueError('Saved access could not be verified for ' + partner['name'])
        if not account and not check.get('app_metadata', {}).get('must_change_password'):
            raise ValueError('Initial password-change requirement was not saved.')
        print('VERIFIED', email, 'role=admin' if email == administrator else 'role=read_only', 'first_password_change=' + str(check.get('app_metadata', {}).get('must_change_password', False)))
    print('COMPLETED:', len(plan), 'linked accounts;', len(created), 'created. Backup:', backup_dir)


if __name__ == '__main__':
    try:
        main()
    except urllib.error.HTTPError as error:
        raise SystemExit('Supabase Auth request failed with HTTP ' + str(error.code))
