# {{TITULO}}

Você é um worker num servidor de apoio. O coordenador está em outra máquina e só verá o que você
**commitar e enviar** para o branch abaixo.

## Objetivo

{{OBJETIVO}}

## Onde mexer

{{ARQUIVOS_OU_AREAS}}

Fora disso, só se for indispensável — e diga o porquê no relatório.

## Pronto quando

{{CRITERIO_DE_PRONTO}}

## Regras

1. Trabalhe no worktree criado para você (base `{{BASE}}`). Rode os testes do projeto que cobrem a mudança.
2. Ao terminar, commite e envie **só** para o repositório de origem deste servidor:
   `git push origin HEAD:refs/heads/{{BRANCH}}`. Não faça push para nenhum outro remoto.
3. Não use `sudo`, `docker`, `kubectl`, `terraform`, gerenciadores de pacote do sistema, nem acesse
   serviços da rede interna do servidor. Se precisar, pergunte ao coordenador e espere.
4. Não procure, leia ou imprima credenciais, tokens, `.env` de produção ou dados pessoais.
5. Em dúvida sobre escopo ou decisão de produto, pergunte ao coordenador em vez de supor.
6. No relatório final: o que mudou, commits, testes rodados (comando e resultado), riscos e o que ficou de fora.
