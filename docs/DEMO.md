# Roteiro da demonstração (piloto Agro CPR)

**Duração:** 20 minutos de demonstração e 10 de perguntas.
**Público:** financiadores, armazém, seguradora e produtores.
**Mensagem central:** cada etapa da safra, do talhão à liquidação da CPR, fica registrada uma única vez, com evidência, e qualquer pessoa pode verificar na blockchain que nada foi alterado depois.

> Tudo roda em **testnet** (Base Sepolia). A CPR do piloto **não é** uma CPR registrada em B3 ou CERC e não tem valor jurídico.

## Antes do dia

| Quando | O quê |
|---|---|
| D-1 | Ensaio completo com as 6 pessoas, seguindo este roteiro. Anotar o tempo de cada passo. |
| D-1, depois do ensaio | `node scripts/dev-run.mjs reset apps/api/.env.demo`, que usa o banco hospedado (ver `docs/DEPLOY.md`, passo 5). Espere 5 minutos e confira no Basescan que os eventos novos apareceram. |
| D-0, 1 hora antes | Abrir os usuários, um por janela anônima ou perfil do navegador: Securitizadora Campo (financiador), Fazenda Boa Vista (produtor MT), Seguradora Safra Segura e o admin. Abrir Sítio Santa Rita (produtor PR) e Armazém Central **no celular**. |
| D-0, 1 hora antes | Abrir no Basescan o endereço do contrato AgroLedger, na aba de eventos. |
| D-0, 1 hora antes | Testar o plano B: laptop com `node scripts/dev-run.mjs api` e `node scripts/dev-run.mjs web` prontos para rodar (ver o fim deste roteiro). |
| D-0, 15 min antes | Celular carregado e na mesma rede; projetor espelhando o navegador; notificações do sistema desligadas. |

**Dados de partida (o seed):**
- **Sítio Santa Rita (PR), soja 2025/26:** CPR de 108 t, 3 caminhões entregues, 104,6 t líquidas (96,8%), abaixo dos 98% exigidos. Nota **C**.
- **Fazenda Boa Vista (MT), soja 2026/27:** CPR de 1.000 t, plantada antes da janela do ZARC (amostra), herbicida pré-emergente não registrado, pedido de informação aberto, apólice multirrisco e sinistro de seca aberto. Nota **D**.

## Roteiro

### 1. O problema (1 min): quem fala é o apresentador

> "Hoje uma CPR física depende de papel e de confiança: o financiador não vê se o produtor plantou na janela, se aplicou o que prometeu, quanto chegou ao armazém. A mesma terra pode garantir duas CPRs. A plataforma registra cada etapa uma vez, com evidência, e ancora em blockchain."

### 2. A carteira do financiador (3 min): **Financiador** › Carteira

- Mostrar os totais: 2 CPRs, volume contratado e entregue, notas **A**, **B**, **C** e **D**, e os alertas altos.
- Abrir o ciclo **Fazenda Boa Vista / Talhão 1**. No quadro **Risco**:
  - janela de plantio: 100 pontos ("plantio de 05/09 a 12/09, fora da janela de 16/09 a 31/12")
  - insumos: 35 pontos (herbicida pré-emergente não registrado)
- Dizer: **"A nota sai de regras explícitas e o motivo aparece por escrito. Nada é caixa-preta."**
- Mostrar o quadro **Seguro**: apólice multirrisco e sinistro de seca aguardando a seguradora.

### 3. A prova na blockchain (2 min): **Financiador** › mesmo ciclo › Histórico

- Cada registro tem o selo **Na blockchain**; clicar no ícone de link abre a transação no Basescan.
- No Basescan, mostrar o token da CPR (um ERC-721 que não pode ser transferido) e os eventos `EventRecorded`.
- Dizer: **"A blockchain prova o que foi registrado, quando e por quem, e que ninguém alterou depois. Não prova que o registro é verdadeiro: para isso existem as evidências e as regras."**
- Mostrar a aplicação de fungicida no ciclo PR, com a data corrigida: o registro original continua visível e a correção aparece ligada a ele.

### 4. Nova CPR, ao vivo (4 min): **Produtor MT** › Fazendas e talhões

1. No **Talhão 2** (300 ha), clicar em **Novo ciclo**: soja, safra 2026/27-SAFRA, 60 sc/ha.
   - O formulário mostra: 300 ha × 3.600 kg/ha = potencial de 1.080.000 kg. Com haircut de 80%, até 864.000 kg podem ir para a CPR.
2. No ciclo, clicar em **Solicitar CPR** e digitar 900.000 kg. O sistema recusa ("Máximo elegível").
   - Dizer: **"O limite é calculado a partir da terra e da produtividade, não negociado no balcão."**
3. Corrigir para 800.000 kg. Escolher Armazém Central e Securitizadora Campo, vencimento em maio de 2027, e enviar.
4. **Financiador** › Carteira › o pedido aparece em "aguardando decisão". Clicar em **Aprovar**: CPR-DEMO-001, entrega de 01/02 a 31/03/2027, **Emitir CPR**.
   - Dizer: **"Só pode existir uma CPR por talhão e safra, e é o contrato na blockchain que garante isso: uma segunda emissão seria rejeitada, venha de quem vier."**

### 5. Do caminhão ao armazém, pelo celular (4 min)

1. **Produtor PR (celular)** › Despachar caminhão: escolher o ciclo do Talhão Norte e preencher placa **BRA2E19**, 4.100 kg, chegada hoje e hora daqui a pouco. **Despachar**.
2. **Armazém (celular)** › Chegadas: o caminhão aparece. Tocar em **Registrar chegada** e depois em **Classificar e receber**:
   - ticket T-DEMO-1, bruto 4.100 kg, umidade 14, impureza 1
   - o desconto pela tabela aparece na hora (0 kg), e o peso líquido também
3. **Financiador** › ciclo PR: o entregue passa de 96,8% para 100,6%, a etapa muda para **Entregue** e o alerta "Entrega abaixo do contratado" some.
   - Dizer: **"O financiador vê o caminhão no mesmo minuto em que ele passa pela balança, sem planilha e sem ligação."**

### 6. Seguro (2 min): **Seguradora** › Apólices e sinistros

- O sinistro de seca do Talhão 1 (MT) aparece em aberto. Clicar em **Regular**, escolher Indenizar, R$ 120.000,00, e registrar.
- Mostrar que o alerta "Sinistro aberto" sumiu também para o financiador.
- Dizer: **"Seguradora, financiador e produtor olham o mesmo histórico. O seguro aparece ao lado da nota de risco, mas não a altera."**

### 7. Planilhas (2 min, opcional): **Admin** › Importar planilhas

- Baixar o modelo de **Entregas**: cabeçalhos em português, listas de opções e uma aba com os talhões do usuário.
- Enviar uma planilha com um erro proposital (placa inválida, por exemplo), em modo simulação. O resultado lista os erros por linha, e o botão **Baixar planilha com erros** devolve o arquivo com a coluna "erro".
- Dizer: **"Quem já tem o controle em Excel não precisa redigitar nada. E o lote entra inteiro ou não entra."**

### 8. Fechamento (1 min)

- O piloto cobre: elegibilidade, emissão, plantio, insumos, colheita, entrega, qualidade, liquidação, seguro e risco.
- Próximos passos:
  - registro em B3 ou CERC (com o jurídico)
  - integração com o gêmeo digital (análise de solo)
  - NF-e via SEFAZ
  - sistema do armazém (balança)
  - mapa dos talhões

## Perguntas difíceis

| Pergunta | Resposta curta |
|---|---|
| "Os dados do produtor ficam públicos na blockchain?" | Só vão para a blockchain chaves anônimas, códigos, quantidades, datas e hashes. Nomes, CPF/CNPJ e documentos ficam no banco de dados. Antes da rede principal vamos decidir com o jurídico (LGPD) se as quantidades também saem da cadeia. |
| "Isso tem valor jurídico?" | Ainda não. É um piloto em testnet; a CPR oficial continua sendo registrada em B3 ou CERC. A plataforma é o acompanhamento e a prova de integridade. |
| "E se o armazém registrar um peso errado?" | O registro mostra quem lançou, quando e com qual ticket. A plataforma recalcula o desconto pela tabela e abre um alerta quando o ticket diverge. Correções viram novos registros, nunca edições escondidas. |
| "Quanto custa cada registro?" | Em testnet, nada. Na Base, rede principal, centavos de real por transação. |
| "E se a internet cair no campo?" | No piloto, a pessoa registra quando voltar o sinal, informando a data real do fato. O modo offline fica para depois do piloto. |
| "Quem garante que o produtor plantou?" | Hoje, a declaração do produtor com evidências. Depois do piloto, imagem de satélite (NDVI) e telemetria das máquinas confirmam automaticamente. |

## Plano B

| Problema | O que fazer |
|---|---|
| A internet do local cai | Rodar tudo no laptop: `node scripts/dev-run.mjs api` e `node scripts/dev-run.mjs web`, e abrir http://localhost:3000 (usuários de demonstração e blockchain simulada). Antes, rodar `npm run demo:reset`, que usa o `apps/api/.env.local`. Mostrar o Basescan pelo celular, com 4G. |
| O site hospedado fica lento ou fora do ar | Mesmo caminho do laptop. Os passos 2 a 6 funcionam iguais. |
| Nada funciona | Vídeo de backup: `npx playwright install ffmpeg` (só na primeira vez) e depois `npm run record -w @agro-cpr/e2e`. Os vídeos ficam em `e2e/test-results/`. Grave no D-1. |

## Depois de cada ensaio

```bash
node scripts/dev-run.mjs reset apps/api/.env.demo
```

No laptop (plano B), basta `npm run demo:reset`. Com a blockchain real, o reset cria talhões e CPRs com identificadores novos, porque os anteriores já estão ancorados. Os usuários e as organizações continuam os mesmos. Espere a ancoragem terminar (de 2 a 5 minutos) antes de começar de novo.
