#!/usr/bin/env python3
"""Recalculate one authorized historical quarter, keeping its balances and original payment."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]


def request(endpoint, method='GET', data=None):
    headers = {
        'apikey': os.environ['SUPABASE_SERVICE_ROLE_KEY'],
        'Authorization': 'Bearer ' + os.environ['SUPABASE_SERVICE_ROLE_KEY'],
        'Content-Type': 'application/json', 'Prefer': 'return=representation',
    }
    req = urllib.request.Request(os.environ['SUPABASE_URL'].rstrip('/') + endpoint,
                                 headers=headers, method=method,
                                 data=None if data is None else json.dumps(data, ensure_ascii=False).encode())
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)


def calculate(record, partners):
    program = "const m=require('./public/model');const fs=require('node:fs');const x=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify(m.calculatePartnerDistribution(x)))"
    data = {'actualDistribution': record['rows']['actual_distribution'], 'partners': partners}
    result = subprocess.run(['node', '-e', program], cwd=ROOT, input=json.dumps(data),
                            capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--period', required=True, help='YYYY-Qn')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    records = request('/rest/v1/closings?select=*&limit=1000')
    program = "const m=require('./public/model');const fs=require('node:fs');console.log(JSON.stringify(JSON.parse(fs.readFileSync(0,'utf8')).map(c=>({...c,_key:m.parsePeriod(c.quarter)?.key}))))"
    parsed = subprocess.run(['node', '-e', program], cwd=ROOT, input=json.dumps(records),
                             capture_output=True, text=True, check=True)
    targets = [c for c in json.loads(parsed.stdout) if c['_key'] == args.period]
    if len(targets) != 1:
        raise ValueError('Expected exactly one existing closing for the requested quarter.')
    record = targets[0]
    record.pop('_key')
    if record['rows'].get('actual_distribution') is None:
        raise ValueError('No actual distribution recorded for this quarter.')
    partners = request('/rest/v1/partners?select=id,name,share,minimum,discount&order=id.asc')
    if not partners or abs(sum(float(p['share']) for p in partners) - 100) > 0.00001:
        raise ValueError('Registered partner percentages must total 100%.')
    distribution = calculate(record, partners)
    summary = {key: value for key, value in distribution.items() if key != 'partnerRows'}
    details = {**record['rows'], 'distribution_basis': 'actual_distribution',
               'distribution_calculated_at': datetime.now(timezone.utc).isoformat(),
               'partner_parameters': partners, 'partner_rows': distribution['partnerRows'],
               'partner_distribution': summary}
    print(json.dumps({'period': args.period, 'summary': summary, 'partners': distribution['partnerRows']}, ensure_ascii=False, indent=2))
    if not args.apply:
        print('DRY RUN: no data changed.')
        return
    backup_dir = Path(tempfile.mkdtemp(prefix='inepad-distribution-backup-'))
    backup = backup_dir / (args.period + '.json')
    backup.write_text(json.dumps({'closing': record, 'parameters': partners}, ensure_ascii=False, indent=2))
    backup.chmod(0o600)
    # JSONB equality provides optimistic concurrency: never overwrite an intervening edit.
    filters = urllib.parse.urlencode({'id': 'eq.' + record['id'], 'rows': 'eq.' + json.dumps(record['rows'], ensure_ascii=False)})
    updated = request('/rest/v1/closings?' + filters, 'PATCH', {'rows': details})
    if len(updated) != 1:
        raise ValueError('The closing changed while calculating; nothing was overwritten. Retry after inspection.')
    check = request('/rest/v1/closings?id=eq.' + record['id'] + '&select=*')
    if len(check) != 1 or check[0]['rows'] != details:
        raise ValueError('The saved distribution could not be verified.')
    for field in ('quarter', 'current_cash', 'previous_distribution', 'distribution_pct'):
        if check[0][field] != record[field]:
            raise ValueError('An unrelated financial field changed concurrently.')
    print('SAVED AND VERIFIED:', args.period, '| backup:', backup)


if __name__ == '__main__':
    try:
        main()
    except urllib.error.HTTPError as error:
        raise SystemExit('Supabase request failed with HTTP ' + str(error.code))
