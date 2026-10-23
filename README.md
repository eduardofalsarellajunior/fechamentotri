# INEPAD · Gestão de caixa

Aplicação na Vercel, com Supabase Auth e PostgreSQL para todos os dados. O navegador apresenta os mesmos cálculos de prévia que o servidor valida ao salvar.

## Configuração

Na Vercel, configure `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` e `ADMIN_EMAIL`. Somente a URL e a chave pública são enviadas ao navegador. O e-mail confirmado em `ADMIN_EMAIL` identifica o único administrador. O login usa Supabase Auth.

O e-mail é obrigatório no cadastro do sócio. Novas contas recebem a senha temporária `inepad123` e são bloqueadas no servidor até a troca por uma senha pessoal. A exigência fica em `app_metadata.must_change_password`, que o usuário não pode alterar. O vínculo entre sócio e e-mail fica no Supabase Auth por `app_metadata.partner_id`. Contas existentes preservam a senha. Só o administrador registra fechamentos e acessa a parametrização; os demais usuários consultam a visão geral.

O banco usa as tabelas de `supabase/schema.sql`. Os dados históricos existentes são preservados. As contas excluídas continuam disponíveis nos saldos dos fechamentos anteriores.

As configurações de URL do Supabase Auth devem usar o domínio principal `https://fechamentotri-edufal.vercel.app`, com esse domínio permitido como destino de recuperação de senha.

## Fluxo

Na visão geral, consulte os indicadores, o gráfico e o histórico. Use `+` em Caixa apurado para expandir a composição das contas e a memória de cálculo. Ano e busca filtram o histórico; Exportar gera CSV com saldos individuais e Imprimir usa o navegador.

O administrador cadastra contas e sócios em Parametrização. Em Novo fechamento, seleciona o período e informa cada saldo. O sistema preenche o caixa e a distribuição efetiva anteriores a partir do histórico; esses campos permitem ajuste manual. Caixa gerado = soma das contas − caixa anterior + distribuição efetiva anterior. O percentual padrão é 90%.

Os mínimos e descontos dos sócios consideram três meses. Complementos até o mínimo são suportados pelo caixa do INEPAD. Resultado negativo não gera distribuição proporcional negativa; os mínimos continuam sendo aplicados. Descontos não tornam o pagamento líquido negativo.

O rateio exibido na abertura do trimestre usa a **distribuição efetiva**, antes de complementos e descontos: participação × distribuição efetiva; extra = máximo entre zero e mínimo mensal × 3 − base proporcional; líquido = base + extra − desconto mensal × 3. O arredondamento de centavos preserva a soma da distribuição base. O resumo separa base, complemento extra, total bruto, descontos e total líquido.

Novos fechamentos e alterações da distribuição efetiva gravam os parâmetros e o demonstrativo dos sócios no registro. O histórico importado sem demonstrativo usa os parâmetros atuais para exibição; os dados originais não são sobrescritos. `scripts/recalculate-distribution.py --period YYYY-Qn` gera prévia de um rateio histórico; `--apply` grava somente o demonstrativo com cópia de segurança e controle de alteração concorrente. `scripts/provision-partner-access.py --manifest /caminho/manifest.json` confere vínculos de e-mail; `--apply` cria os acessos autorizados sem redefinir senhas existentes. Os manifestos com dados pessoais devem ficar fora do repositório.

O período vazio da planilha fica como A preencher. Ao salvar esse período, a aplicação completa o registro existente. Um trimestre já fechado não pode ser salvo novamente. Nos registros importados, o caixa gerado é reconstituído com a fórmula atual, e a distribuição efetiva mantém o valor original da planilha.

## Validação

`npm test` executa cálculos e integração com Supabase simulado. `python3 tests/ui-smoke.py` usa Playwright e Chromium para testar a interface com dados simulados, sem alterar produção. Instale Playwright e seu navegador no ambiente de testes antes de executar o teste visual.

`npm start` serve a aplicação para desenvolvimento. Use variáveis de ambiente fornecidas pelo shell; não há persistência local. Um push na branch `main` aciona o deployment automático da Vercel.
