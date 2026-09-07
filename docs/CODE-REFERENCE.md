> **Note for English readers.** This file is in Portuguese: a file-by-file code
> reference written while preparing the security fix, received on 2026-09-05
> and kept verbatim as a working record. Its headings are not translated; the
> English description of the same code paths is [`ARCHITECTURE.md`](ARCHITECTURE.md).
> Line numbers refer to the code as of 2026-09-05 and will drift.

# KYA · Referência de código

> Material de estudo pessoal, não publicação. Escrito em 20/08/2026 lendo o
> código commitado em `85164bb`, com todos os números conferidos rodando o
> código, não recordados. Onde o código diverge de `PLAN.md` ou `DECISIONS.md`,
> a seção 7 aponta a divergência em vez de escolher um lado.
>
> **Revisão de 21/08/2026**: a seção 3 foi reprocessada contra as fixtures
> recapturadas em 21/08 12:23 UTC (commit `83357c3`), que são as que a demo
> replica agora. As colunas de 17/08 e 20/08 ficam nas tabelas como histórico.
> O caminho do score (`score.ts`, `config.ts`, `signals.ts`, `funding.ts`,
> `verdict.ts`) não mudou desde `85164bb`; só `blockscout.ts` mudou, e só em
> comentários (ver 7.1 e 7.3).

**Índice**

1. [Mapa de arquivos](#1-mapa-de-arquivos)
2. [O caminho de uma chamada](#2-o-caminho-de-uma-chamada)
3. [A matemática do score, resolvida](#3-a-matemática-do-score-resolvida)
4. [As decisões que estão no código](#4-as-decisões-que-estão-no-código)
5. [Modos de falha](#5-modos-de-falha)
6. [Os números que eu preciso saber de cor](#6-os-números-que-eu-preciso-saber-de-cor)
7. [Divergências entre o código e os docs](#7-divergências-entre-o-código-e-os-docs)

---

## 1. Mapa de arquivos

Ordenado pela ordem em que são chamados: primeiro quem começa, depois o pipeline
de um verify na ordem exata, depois o que só roda fora do caminho quente.

### Entradas: quem começa a execução

| Arquivo | O que faz | O que **NÃO** faz |
|---|---|---|
| `src/cli.ts` | Ponto de entrada humano. `loadDotEnv()`, aplica `--offline`, chama `verify()` e imprime o pipeline inteiro numa tela: badge, eixos, sinais, evidência, atestado. | Não calcula nada. Todo número que ele mostra vem pronto de `verify()`; é só formatação. |
| `src/server.ts` | Express: `GET /verify?address=…` (+ `explain=1`, `offline=1`) e serve `ui/` estático. Traduz exceção em status HTTP (400/404/502/500) e põe `X-KYA-Source`. | Não guarda estado, não cacheia resposta (`cache-control: no-store`), não decide política de frescor, só devolve `issued_at` e `fetched_at`. |
| `demo/paid-endpoint.ts` | Lado vendedor: monta `kyaGate()` → `paymentMiddleware()` (x402-express) → `GET /chem`. Em modo padrão sobe um **facilitator stub** local que responde `/verify` e `/settle` sem mover fundos. | Não move dinheiro no modo padrão, não checa assinatura de pagamento (o stub aceita tudo), não lê reputação sozinho, delega ao gate. |
| `demo/agents.ts` | Lado comprador: dois agentes contra o mesmo endpoint. Com chave, vira cliente `x402-fetch` real; sem chave, monta um `X-PAYMENT` sintético (mesmo formato, assinatura placeholder). | Não valida o veredito, só compara `status` com `expect`. Não paga de verdade a menos que `--real`. |
| `src/gate.ts` | Middleware Express. Lê `X-PAYMENT`, extrai `payload.authorization.from`, chama `verify()`, e devolve **403 antes da liquidação** se `suspicious`. `unknown` e `trusted` passam com header `X-KYA-Verdict`. | **Não verifica a assinatura do pagamento** (ver §4). Não bloqueia `unknown`. Não inventa veredito para pagador que não conseguiu nomear, deixa passar para o x402 rejeitar. |

### O pipeline de um verify, na ordem exata

| Arquivo | O que faz | O que **NÃO** faz |
|---|---|---|
| `src/config.ts` | Só constantes + `loadDotEnv()`. Separa explicitamente **MEDIDO** (`THRESHOLDS`, `VERDICT`) de **ESCOLHIDO** (`WEIGHTS`, `SCORE.eps`, `SCORE.confidenceK`, `FUNDING_LEVEL`, `CADENCE_PENALTY`). | Nenhuma lógica. Não lê rede, não valida nada. Módulos de biblioteca **não** chamam `loadDotEnv`, só as entradas. |
| `src/verify.ts` | O orquestrador, a única definição de "verify". `parseAddress` → `loadHistory` → `deriveSignals` + `deriveFunding` → `scoreAddress` → `decide` → `buildAttestationBody` → `signAttestation`. | Não fala com a rede diretamente. Tudo depois do `loadHistory` é puro e determinístico (exceto `issued_at`). |
| `src/history.ts` | A **única costura** que decide live / cache / fixture. TTL de 10 min no cache; offline lê `data/fixtures/` e cai para `data/cache/` em qualquer idade; senão `NoFixtureError`. | Nunca toca a rede em modo offline. Não faz fallback silencioso: sem fixture é erro, não resposta inventada. |
| `src/blockscout.ts` | Toda a rede. 6 requisições HTTP por verify (7 se `/counters` estiver frio), rate-limit de 4 starts/s process-wide, retry, backoff, timeout de 8 s. Poda campos pesados (`pickTx`) antes de cachear. | **Nunca chama `base.blockscout.com`**: o explorer público só vira link de evidência em `blockscoutUrl()`. Não interpreta sinal nenhum. |
| `src/signals.ts` | História crua → os 4 sinais: idade, volume, diversidade, cadência (+ `burstRatio`). Rebaixa `txCount` para o tamanho da janela com `txCountExact: false` se `/counters` for incoerente. | Não pontua, não pesa, não julga. Diversidade e cadência saem daqui com peso zero rio abaixo. |
| `src/stats.ts` | Uma definição só de percentil (interpolação linear, o default do numpy), compartilhada entre runtime e calibração. | Nada além disso. Existe para calibração e runtime não divergirem sobre o que é "p25". |
| `src/funding.ts` | Quem pagou o primeiro inbound. Nativo ganha de token. Ordem de severidade: OFAC → mixer → `lookupCex` (confirmado) → heurística `EXCHANGE_CLASS` (inferido). | Não prova posse: transferência não solicitada existe. `identity` (confirmed/inferred) **nunca** muda `class`, e só `class` entra no score. |
| `src/cex-labels.ts` | Lê `data/cex-addresses-evm.json` (Dune Spellbook, commit pinado `9f61b0d`, 4.957 endereços, 328 exchanges) e devolve nome + proveniência. | Não prova que a wallet é hot wallet ativa na Base, nem que o pagador é dono da conta. Não é oráculo: é lista comunitária, pode estar velha. |
| `src/sanctions.ts` | Mapa estático das 100 SDN "Digital Currency Address - ETH" (publicação OFAC de 07/08/2026), com o nome da entidade para dizer ao bloqueado o que casou. | Não atualiza sozinho. Não cobre mixers (questão separada, ver `KNOWN_MIXERS`). |
| `src/score.ts` | Sinais + funding → 0..1000. Normaliza, aplica o piso EPS, média geométrica ponderada em log-space, penalidade, confidence. O **compliance gate** roda antes e vence. | Não decide verdito (isso é `verdict.ts`). Não normaliza o eixo funding: `FUNDING_LEVEL` já é 0..1. Um gated volta com `score 0` e `geometricMean 0`. |
| `src/verdict.ts` | Score → `trusted` / `unknown` / `suspicious` nos cortes 84/193, mais a frase única para humano. `gated` é eixo separado, não verdito. | Não recalcula nada. Um gated é reportado `suspicious` **e** `gated`, para quem só lê o verdito ainda bloquear. |
| `src/attest.ts` | Monta o corpo snake_case, serializa canônico (RFC 8785), assina EIP-191, e devolve o corpo **já em ordem canônica** com `signature` no fim. `recoverAttester()` faz o caminho de volta. | Não fala com a rede. Não decide em quem confiar: `attester` está no corpo só para descoberta, quem consome tem que pinar o endereço. |

### Fora do caminho quente: calibração, fixtures, dados

| Arquivo | O que faz | O que **NÃO** faz |
|---|---|---|
| `scripts/capture.ts` | Lê a Blockscout agora e grava `data/fixtures/<address>.json` para os 4 endereços da demo (ou os que você passar). Imprime score/verdito de cada captura. | Não inventa caso: fixture é **captura datada de endereço vivo**, com `captured_at`. Não é mock. |
| `scripts/collect.ts` | `data/addresses.csv` → `data/signals.csv`, a evidência commitada atrás de todo número calibrado. | Não calibra e não pontua. Só coleta. |
| `scripts/calibrate.ts` | Lê `signals.csv` e imprime min/p25/p50/p75/max por sinal por grupo, os pares ZERO/FULL, e os cortes de verdito. Cola-e-commita em `config.ts`. | Não escreve em `config.ts` sozinho: o limiar é **output** do repositório, conferido no olho e commitado à mão. |
| `scripts/build-cex-labels.ts` | Reconstrói `data/cex-addresses-evm.json` do Dune Spellbook no commit pinado, byte a byte (só `built_on` muda). | Não busca lista "mais recente": o ponto é reprodutibilidade, não frescor. |
| `src/csv.ts` | CSV RFC4180 mínimo com linhas de comentário `#`, usado só pelos scripts de calibração. | Não entra em nenhum caminho de runtime. |

---

## 2. O caminho de uma chamada

`GET /verify?address=0xBEabA203…`

### Antes de qualquer request

`server.ts` `main()` chamou `requireVerifyConfig()` no boot. Isso roda
`requireApiKey()` (pulado se offline) e `attesterAccount()`. **Config quebrada
mata o processo no boot, não na primeira requisição.**

### Função por função

```
server.ts  app.get('/verify')  →  handleVerify(req, res)
```

1. **`handleVerify`** (`server.ts:74`) lê `req.query.address`, `explain`, `offline`.
   `const offline = isOffline() || req.query.offline === '1'`: o `--offline` do
   servidor **vence**; a requisição só pode optar por entrar, nunca por sair.

2. **`verify(input, { offline })`** (`verify.ts:76`): o orquestrador:

   1. **`parseAddress(input)`** → `viem.isAddress` + `getAddress`.
      Não é endereço → `InvalidAddressError`. **Nada de rede aconteceu ainda.**
   2. **`attesterAccount()`** → `privateKeyToAccount(ATTESTER_PRIVATE_KEY)`.
   3. **`loadHistory(address, { offline })`** (`history.ts:138`): a única costura:
      - **offline**: `readHistoryFile('data/fixtures/<addr>.json')` → `source: 'fixture'`;
        senão `data/cache/<addr>.json` **em qualquer idade** → `'cache'`;
        senão `NoFixtureError`. **Zero requisições de rede.**
      - **live**: cache com `captured_at` a menos de `CACHE_TTL_MS` (10 min) → `'cache'`,
        **zero requisições**; senão `fetchAddressHistory()`.
   4. **`deriveSignals(history)`**: puro.
   5. **`deriveFunding(history)`**: puro. `earliestInbound` nos nativos, depois nos
      tokens; nativo ganha. Depois `classifyFunder`: OFAC → mixer → `lookupCex` → heurística.
   6. **`scoreAddress(signals, funding)`**: puro. Gate de compliance primeiro, depois a conta.
   7. **`decide(breakdown)`**: puro.
   8. **`buildAttestationBody(...)`** + **`signAttestation(body, account)`** →
      `canonicalize()` → `account.signMessage()` (EIP-191). Puro e offline.

3. De volta em `handleVerify`: `cache-control: no-store`, `X-KYA-Source: live|cache|fixture`,
   `200` com o atestado (ou `{ attestation, breakdown, source, captured_at }` se `explain=1`).

### Quantas chamadas de rede saem, para onde, em que ordem

Tudo dentro de **`fetchAddressHistory()`** (`blockscout.ts:447`), e tudo para
**`https://api.blockscout.com`** (Blockscout Pro, key-gated, header `Authorization: Bearer`).

Um `Promise.all` de quatro coisas, que somam **6 requisições HTTP**:

| # | Função | Rota | Requisições |
|---|---|---|---|
| 1 | `fetchEarliestTransactions` | `/v2/api?chain_id=8453&module=account&action=txlist&sort=asc&page=1&offset=10` | 1 |
| 2 | `fetchEarliestTokenTransfers` | `…&action=tokentx&sort=asc&page=1&offset=10` | 1 |
| 3 | `fetchTransactionWindow` | `…&action=txlist&sort=desc&page=1..3&offset=50` (3 páginas em paralelo) | **3** |
| 4 | `fetchCounters` | `/8453/api/v2/addresses/{addr}/counters` | 1 |

Depois do `Promise.all`, um teste: se `counters.transactionsCount < window.length`,
o contador está frio → **uma releitura** de `fetchCounters` → **7 no total**.

**Ordem real na rede.** As 6 saem concorrentes, mas cada uma passa por
`acquireSlot()` antes do `fetch`: no máximo **4 starts por segundo rolante**,
process-wide e serializado por uma fila de promises. Então a 5ª e a 6ª esperam
~1 s. Um verify live típico é **duas rajadas: 4 requisições, ~1 s de pausa, mais 2**.
Com `/counters` frio, uma 7ª logo depois.

**Zero chamadas para `base.blockscout.com`.** O explorer público só aparece como
string em `blockscoutUrl()`, dentro de `evidence.blockscout_url`. É link para
humano clicar, nunca uma dependência de runtime.

**Modo offline: zero requisições de rede, e nem chave de API é necessária**
(`requireVerifyConfig` pula `requireApiKey()` quando offline).

### O caminho pelo gate (a demo)

Igual, com um prefixo:

```
GET /chem  →  kyaGate()  →  payerFromPaymentHeader(header)  →  verify(payer)
                                                              ↓
                             suspicious? → 403 + atestado, e x402-express NUNCA roda
                             unknown/trusted? → next() → paymentMiddleware → handler → settle
```

A ordem é o produto: `x402-express` só liquida depois que o handler responde 2xx,
e não roda de jeito nenhum se o gate respondeu antes. **403 do gate = o agente
recusado pagou zero e o vendedor arriscou zero.**

---

## 3. A matemática do score, resolvida

Caso 2, `0xBEabA203Ef49Ee2828b77b0B7E84839e76092787`, **fixture de 21/08/2026
12:23:40 UTC** (commit `83357c3`), a mesma que a demo replica offline.

### Os sinais brutos, saindo de `deriveSignals` + `deriveFunding`

```
ageDays      6.99          (first seen 2026-08-14T12:43:05Z)
txCount      42            exato (/counters coerente com a janela)
windowSize   42            = evidence_mass
burstRatio   26
funding      class 'exchange', Binance 76, identity confirmed
```

### Passo 1: normalizar cada eixo

`normalize(x, zero, full) = clamp((x − zero) / (full − zero), 0, 1)`

**funding**: não passa por `normalize`. `FUNDING_LEVEL['exchange']` já é 0..1:

```
s_funding = 1.0
```

**maturity**: `THRESHOLDS.ageDays = { zero: 3.03, full: 532.09 }`:

```
s_maturity = (6.99 − 3.03) / (532.09 − 3.03)
           = 3.96 / 529.06
           = 0.00748497334895853
```

**volume**: `THRESHOLDS.txCount = { zero: 54.75, full: 2236.25 }`:

```
s_volume = (42 − 54.75) / (2236.25 − 54.75)
         = −12.75 / 2181.5
         = −0.005844…            → clamp → 0
```

O endereço tem **menos** transações que o piso do sinal, então o numerador é
negativo e o clamp zera. Não é bug: é o sinal dizendo "abaixo de indistinguível-de-novo".

### Passo 2: o EPS entra

`SCORE.eps = 0.02`. Em `geometricMean`, cada eixo vira `max(normalized, EPS)`:

```
funding    max(1.0,       0.02) = 1.0        ← acima do piso
maturity   max(0.0074850, 0.02) = 0.02       ← PISADO
volume     max(0,         0.02) = 0.02       ← PISADO
```

**Este é o fato central deste caso: dois dos três eixos estão no piso.**

### Passo 3: a média geométrica

Calculada em log-space (`score.ts:67`), porque produto de potências é soma
ponderada de logs:

```
ln(0.02) = −3.912023005428146

logSum = 0.40·ln(1.0)  + 0.35·ln(0.02)      + 0.25·ln(0.02)
       = 0.40·0        + 0.35·(−3.912023…) + 0.25·(−3.912023…)
       = 0             + (−1.369208051899851) + (−0.9780057513570365)
       = −2.3472138032568877

G = exp(−2.3472138032568877) = 0.09563524997900369
```

Atalho para o quadro: como `funding = 1` contribui `1^0.40 = 1`, e os outros dois
estão ambos no piso, **G colapsa para `0.02^(0.35+0.25) = 0.02^0.6 ≈ 0.0956`**.
(Confirmado: `Math.pow(0.02, 0.6) = 0.09563524997900372`, mesma coisa até o último bit útil.)

### Passo 4: penalidade

`CADENCE_PENALTY = { burstRatioThreshold: 50, burstMultiplier: 0.85 }`.
`burstRatio = 26 ≤ 50` → **sem penalidade**:

```
penalty = 1.0
```

### Passo 5: confidence

`confidence = evidence_mass / (evidence_mass + k)`, com `k = SCORE.confidenceK = 25`
e `evidence_mass = windowSize = 42`:

```
confidence = 42 / (42 + 25) = 42 / 67 = 0.6268656716417911
```

### Passo 6: o 1000×

```
score = round(SCORE.scale · G · penalty · confidence)
      = round(1000 · 0.09563524997900369 · 1.0 · 0.6268656716417911)
      = round(59.95045521071874)
      = 60
```

### Passo 7: verdito

`verdictFor(60)`: `60 ≤ VERDICT.suspiciousMax (84)` → **`suspicious`**.
E como `confidence 0.63 ≥ 0.5`, **não** entra a razão de "thin evidence".

### A versão de quadro, cinco linhas

```
1.  funding é máximo (Binance 76 confirmada)     → 1^0.40 = 1, contribui nada
2.  idade 6,99d e volume 42tx caem ABAIXO do piso → os dois viram EPS = 0,02
3.  G = 0,02^(0,35+0,25) = 0,02^0,6              ≈ 0,0956
4.  confidence = 42/(42+25)                       ≈ 0,627
5.  1000 × 0,0956 × 1 × 0,627 = 59,95            → 60  → SUSPICIOUS (≤ 84)
```

### Por que o score não se moveu entre 17/08 e 21/08

Rodei as três leituras pelo mesmo código:

| | fixture 17/08 | ao vivo 20/08 | **fixture 21/08 (atual)** |
|---|---|---|---|
| `ageDays` | 3.26 | 6.11 | **6.99** |
| `s_maturity` normalizado | 0.00043473330057082363 | 0.005821645938078857 | **0.00748497334895853** |
| depois do piso EPS | **0.02** | **0.02** | **0.02** |
| `txCount` / `windowSize` | 42 / 42 | 42 / 42 | **42 / 42** |
| `G` | **0.09563524997900369** | **0.09563524997900369** | **0.09563524997900369** |
| `confidence` | 0.6268656716417911 | 0.6268656716417911 | **0.6268656716417911** |
| score | 60 | 60 | **60** |

Do 17/08 ao 21/08 o `s_maturity` normalizado ficou **17,2 vezes** maior (a idade
crua só dobrou, 2,1×) e `G` é idêntico **até o último dígito nas três colunas**.
Porque `0.00043`, `0.0058` e `0.0075` são todos `< 0.02`: os três são pisados no
mesmo EPS.
**O score deste endereço não é uma função da idade dele hoje: é `EPS^0.6 × confidence`.**

Se alguém perguntar "e se ele envelhecer até a apresentação", a resposta é aritmética:

- **maturity só sai do piso** quando `s_maturity = 0.02`, ou seja
  `ageDays = 3.03 + 0.02 × 529.06 = 13.6112 dias` → **28/08/2026 03:23 UTC**.
  Da fixture de 21/08 (6,99 dias) **faltam 6,62 dias**.
- **volume só sai do piso** quando `txCount = 54.75 + 0.02 × 2181.5 = 98.38` transações
  → **faltam 56,38** a partir das 42 da fixture (e o endereço segue dormente:
  0 tx nas últimas 24 h, 42 em 7 d).

Nenhum dos dois acontece antes de sábado 22/08, o dia da apresentação. E como a
demo roda offline, a fixture congela `ageDays` no instante do `captured_at`
(`signals.ts:95` usa `Date.parse(fetchedAt)`, não o relógio): o número na tela
não muda entre gravar o áudio e apresentar.

---

## 4. As decisões que estão no código

As cinco que você listou, e mais algumas que um leitor atento pergunta na sequência.

**Por que o EPS existe** (`config.ts:127`, aplicado em `score.ts:70`): sem piso,
um único eixo em zero zera o produto inteiro e todo mundo com pouco volume vira
score 0, indistinguível de sancionado. O piso faz um eixo fraco **amortecer** em
vez de aniquilar. *Efeito colateral que o caso 2 prova: ele também achata tudo
que está abaixo do piso, então dois endereços muito diferentes ali embaixo
recebem o mesmo score.*

**Por que a releitura do `/counters`** (`blockscout.ts:455`): a Blockscout calcula
os contadores preguiçosamente: um endereço frio responde 0 enquanto o número real
está nos milhares. A janela é subconjunto de todas as transações, então um contador
**abaixo** de `window.length` é prova de que ele está frio; uma releitura resolve, e
se ainda vier incoerente `signals.ts` rebaixa para o limite inferior da janela com
`txCountExact: false` (a CLI passa a imprimir `>= N transactions`).

**Por que o gate lê o header sem verificar assinatura** (`gate.ts:14-18`): porque o
`x402-express` logo atrás verifica. Um `from` forjado falha lá e **nunca liquida**,
então o único endereço que pode ser cobrado é o que assinou. O gate duplicar a
verificação não compraria segurança nenhuma e custaria uma dependência de cripto
no caminho quente.

**Por que o cache tem TTL de 10 minutos** (`history.ts:31`): atestado é
ponto-no-tempo, então cache longo mentiria sobre `fetched_at`; 10 min é curto o
bastante para uma re-execução de demo ler dado praticamente fresco, e longo o
bastante para as duas telas da UI não gastarem 12 a 14 requisições contra a cota do
free tier. E o formato é o mesmo das fixtures: **uma fixture é uma entrada de cache
que foi mantida e commitada.**

**Por que a serialização é canônica** (`attest.ts:120-136`): chaves ordenadas
recursivamente, sem espaço em branco, que é RFC 8785 (JCS) para estes dados. Assim
um consumidor em qualquer linguagem reconstrói os **bytes exatos** que foram
assinados. E `signAttestation` devolve o corpo já parseado da forma canônica com
`signature` no fim, então a API **serve** em ordem ordenada: em JavaScript a
conferência não precisa de biblioteca nenhuma:

```js
const { signature, ...body } = attestation
await recoverMessageAddress({ message: JSON.stringify(body), signature })
```

*Conferido hoje contra o servidor: recupera `0xCEFEDCf160e8065ce82B949A0dFc777BD2E2Cd8C`,
igual ao campo `attester`, e as chaves servidas saem em ordem alfabética.*

Mais quatro que costumam vir logo depois:

**Por que média geométrica e não soma** (`score.ts:6-9`): com soma, um agente com
funding suspeito compensa com volume alto. Com produto, não compensa. É a forma
certa para reputação: um eixo fraco não se compra de volta.

**Por que `unknown` vale 0.35 e não 0** (`config.ts:107-113`): a maioria das wallets
da Base é financiada por endereço que lista nenhuma conhece. Isso é **ausência de
evidência, não evidência de comportamento ruim**. Fica abaixo de `exchange` porque
saque de exchange carrega um registro de identidade atrás, e uma EOA desconhecida
não carrega nada.

**Por que `lookupCex` roda antes da heurística e ambos devolvem a mesma classe**
(`funding.ts:131-138`): a lista muda o que o KYA pode **afirmar** sobre um
financiador (`identity: confirmed` + nome + fonte citável), nunca o quanto ele
**conta**. O score lê só `class`. Medido: 0 classes e 0 scores mudaram nos 30
endereços quando a lista entrou.

**Por que só `suspicious` bloqueia** (`gate.ts:26-30`): `unknown` é "tem histórico,
não o bastante para eu avalizar". Bloquear isso é política do vendedor, não do KYA;
o header `X-KYA-Verdict` entrega a decisão a quem tem que tomá-la.

**Por que diversidade e cadência têm peso zero** (`config.ts:69-74`): a calibração
mostrou que não separam: diversidade dá 0.09× (o estrato established tem bots
antigos de uma contraparte só) e cadência **inverte** (bot fresco dispara 150 tx num
dia, endereço estabelecido fica dormente, mede atividade atual, não track record).
O estrato **não** foi recomposto para consertar os números, porque escolher os
established pela diversidade garantiria que a diversidade separasse. Os dois
continuam coletados e exibidos, com peso zero declarado.

---

## 5. Modos de falha

| O que dá errado | O que o sistema devolve | Onde no fluxo |
|---|---|---|
| **Endereço inválido** ✅*testado* | `InvalidAddressError` → CLI stderr + exit 1; server **400** `{error, usage}` | `verify.ts:54` `parseAddress`, **antes de qualquer rede** |
| Endereço vazio | `"address is required"` → **400** | `verify.ts:33`, mesmo ponto |
| **Endereço com 0 transações** ✅*testado* | Não é erro: `suspicious`, score **0**, `confidence 0.00`, razão explícita "*Scoring low for lack of data, not for bad behaviour*" | `score.ts:180`, caminho normal (`0xeB94Dd34…`) |
| Endereço na SDN do OFAC | `gated: true`, score **0**, verdito `suspicious`, `gateReason` com o nome da entidade | `score.ts:131`, **antes** da média geométrica (`0x098B716B…`) |
| Financiado por mixer/sancionado | Mesmo shell gated, razão "*first inbound came from…*" | `score.ts:140` |
| Offline sem fixture | `NoFixtureError` (lista as fixtures disponíveis) → server **404**; gate **503** | `history.ts:155`. ⚠️ `NoFixtureError extends BlockscoutError`, então a ordem dos `catch` importa: `server.ts` testa `NoFixtureError` **antes** de `BlockscoutError` |
| **Blockscout responde 500** ✅*testado* | Retriable → 1 retry (backoff ~0,5 a 0,75 s) → `BlockscoutError` → **502** (server) / **503** (gate). ~1 s | `blockscout.ts:278` |
| **Blockscout pendurado** ✅*testado* | `AbortSignal.timeout(8_000)`, `MAX_RETRIES = 1` → 2 tentativas → ~17 s → **502**/**503** | `blockscout.ts:252` |
| Blockscout responde 429 | Até 3 retries próprios, honrando `Retry-After`, com aviso no stderr; esgotado, cai no orçamento normal | `blockscout.ts:284`. *Aconteceu na leitura ao vivo de hoje, recuperou na retry 1/3* |
| Chave de API errada (401/402) | Lançado **na hora, sem retry** ("Check BLOCKSCOUT_API_KEY") → 502/503 | `blockscout.ts:267` |
| `/counters` frio | Uma releitura; se ainda incoerente, `txCount = window.length` e `txCountExact: false` | `blockscout.ts:455` → `signals.ts:127` |
| `ATTESTER_PRIVATE_KEY` ausente/malformada | `ConfigError` **no boot**, processo não sobe, exit 1 | `attest.ts:106` via `requireVerifyConfig()` |
| `BLOCKSCOUT_API_KEY` ausente (modo live) | `ConfigError` no boot. **Offline não precisa de chave** | `blockscout.ts:164`, pulado por `verify.ts:67` |
| Checkout read-only, cache não grava | Engolido de propósito: cache é conveniência, não pode quebrar um verify | `history.ts:168` |
| Requisição sem header `X-PAYMENT` | `next()`, não há pagador para checar; o x402 responde 402 com os requisitos | `gate.ts:94` |
| `X-PAYMENT` sem pagador decodificável | `next()`, o gate **não inventa veredito**; o x402 rejeita como malformado | `gate.ts:100` |
| Erro inesperado dentro do verify | Gate: **500** "internal error, payment refused before settlement". Server: **500** `{error: 'internal error'}` | `gate.ts:112`, `server.ts:107` |

Regra que atravessa tudo: **fail-closed antes da liquidação**. Se a reputação não
pode ser lida, o vendedor não serve às cegas, e ninguém pagou por um veredito
que não existe.

---

## 6. Os números que eu preciso saber de cor

**Cortes de verdito**: MEDIDOS
```
suspicious ≤ 84  <  unknown  <  193 ≤ trusted
vão vazio entre os clusters: 109 pontos
```
84 = o score mais alto que qualquer endereço *fresh* alcançou.
193 = o mais baixo que qualquer *established* alcançou. Nada vive no meio.

**Pesos**: ESCOLHIDOS, pelo custo de forjar
```
funding 0.40   maturity 0.35   volume 0.25
(fallback sem funding: maturity 0.58 / volume 0.42)
```

**Limiares ZERO/FULL**: MEDIDOS, `npx tsx scripts/calibrate.ts` reproduz
```
age_days    3.03 → 532.09     separa 176×
tx_count   54.75 → 2236.25    separa  41×
```

**A fórmula**
```
score = 1000 · G · penalty · confidence        G = ∏ max(s_k, EPS)^w_k
EPS = 0.02        confidence k = 25        scale = 1000
```

**Níveis de funding**: ESCOLHIDOS
```
exchange 1.0   unknown 0.35   none 0.05   mixer 0   sanctioned 0
```

**Penalidade de cadência**: ESCOLHIDA
```
burstRatio > 50  →  × 0.85       (mínimo 21 tx para medir)
```

**Janela e rede**
```
janela          3 páginas × 50 = 150 tx no máximo
earliest limit  10 linhas
por verify      6 requisições HTTP  (7 se /counters estiver frio)
pacing          4 starts por segundo, process-wide
timeout         8 s por requisição, 2 tentativas → ~17 s no pior caso
cache TTL       10 minutos
```

**Conjunto de calibração**
```
n = 30   (10 fresh · 10 mid · 10 established)
separação: fresh 10/10 suspicious · established 10/10 trusted · mid 4/2/4
frame: EOAs que enviaram USDC na Base nos blocos 50021246 a 50021255
```

**Listas**
```
OFAC SDN     100 endereços, publicação 07/08/2026, 15 ativos na Base
CEX labels   4.957 endereços, 328 exchanges, dune-spellbook@9f61b0d (28/01/2026)
```

**Ambiente**
```
reputação   Base mainnet, chain 8453
pagamento   base-sepolia, $0.001 USDC
portas      3000 (server) · 4021 (demo endpoint)
attester    0xCEFEDCf160e8065ce82B949A0dFc777BD2E2Cd8C
```

---

## 7. Divergências entre o código e os docs

Encontradas conferindo o código contra `PLAN.md`, `DECISIONS.md` e `README.md`.
**As quatro foram corrigidas em 20/08/2026**: ficam registradas aqui com o que
era e o que virou, porque a explicação ainda é material de estudo. Só os textos
mudaram; nenhum número medido foi alterado.

### 7.1 `blockscout.ts` se contradizia sobre quantas chamadas faz ✅ corrigido

Era: cabeçalho dizia *"The **three** bounded Blockscout calls"* (linha 2) e
*"**3 to 5 requests**"* (linha 18), enquanto o comentário de rate limit (linha 55)
dizia *"6 calls (7 when cold)"*.

O real, contando `fetchAddressHistory` linha a linha: `txlist asc` (1) +
`tokentx asc` (1) + `txlist desc × 3 páginas` (3) + `counters` (1) = **6**, mais a
releitura condicional = **7**. O cabeçalho contava *grupos lógicos* e estava
desatualizado desde que a janela virou 3 páginas e o `tokentx` entrou.

Agora o cabeçalho lista as **quatro leituras** com o custo em requisições de cada
uma, mantendo a numeração que as docstrings de cada função já usam (`Call 1` =
earliest, `Call 2` = window, `Call 3` = counters, `Call 4` = tokentx).

### 7.2 O mesmo cabeçalho descrevia a rota errada para a janela ✅ corrigido

Era: `blockscout.ts:5` listava a chamada 2 como `addresses/{addr}/transactions`
(rota v2). Mas `fetchTransactionWindow` usa a **Etherscan-compatible `txlist`**,
e a docstring da própria função explica por quê (v2 respondeu 500 para 23 de 30
endereços, ~20 s por página, e pagina por cursor, o que impede buscar as 3 páginas
em paralelo). O cabeçalho também dizia `offset=1` onde o código passa
`EARLIEST_LIMIT = 10`.

Agora o cabeçalho traz a rota certa, o `offset=10` certo, e uma linha explícita
dizendo que a janela **não** usa v2, apontando para a função.

### 7.3 Cota do free tier: mês vs dia ✅ corrigido

Era: `blockscout.ts:55` dizia *"100,000 credits a **month**"*; `README.md:183` dizia
*"100,000 credits a **day**, renewed daily"*. O commit `85164bb`
("*correct free tier quota*") tinha corrigido o README e não tocado o código.

Nota de aritmética que continua valendo: 100.000 ÷ 20 = 5.000 chamadas; os
"~700 verifies por dia" do README saem de 5.000 ÷ 7, ou seja assumem o pior caso
de 7 chamadas. Com 6, dariam ~833.

### 7.4 `PLAN.md` carregava uma calibração superada ✅ corrigido

Era: `PLAN.md:180` dizia "medidos em 15/08" e `config.ts:34` diz
"MEASURED, 2026-08-16". Rodadas diferentes, números diferentes:

| sinal | `PLAN.md` (rodada 15/08, agora removida) | `config.ts` + `calibrate.ts` (16/08) |
|---|---|---|
| `age_days` | 2.84 → 531.89, 187× | **3.03 → 532.09, 176×** |
| `tx_count` | 53.75 → 1894.50, 35× | **54.75 → 2236.25, 41×** |
| `diversity` | 5.75 → 6.00, 0.25× | 5.75 → 6.25, 0.09× |
| `txs_24h` | 32.75 → 7.00 | 30.25 → 7.50 |
| `txs_7d` | 53.75 → 41.25 | 54.75 → 41.25 |

O `PLAN.md` agora traz a coluna da direita, mais uma nota dizendo de qual rodada
ela veio. A tabela de pesos (`PLAN.md` §c2) também repetia 187× e 35×; virou
176× e 41×.

**⚠️ Duas armadilhas que sobrevivem à correção, e que valem para o pitch:**

1. **`calibrate.ts` não emite razão de separação nenhuma.** Ele imprime só ZERO e
   FULL. A coluna `separação` (`176x`, `41x`, `0.09x`) é **anotação à mão** em
   `src/config.ts`. Se alguém pedir para reproduzir "176×" rodando o script, o
   script não vai imprimir isso.
2. **Essa coluna usa duas convenções diferentes.** `176x` e `41x` são `FULL/ZERO`
   (175.61 e 40.84, arredondados). Mas o `0.09x` da diversidade é
   `(FULL−ZERO)/ZERO` = 0.087; por `FULL/ZERO` ele seria **1.09x**. Não "consertei"
   porque isso mudaria um número medido: está registrado na nota do `PLAN.md`.

### 7.5 O que **não** divergiu

Conferido e batendo entre código e docs: a fórmula do score e o EPS 0.02
(`PLAN.md:212-217`), a constante 25 da confidence, os pesos 0.40/0.35/0.25, os
cortes 84/193 e o vão de 109 (`PLAN.md`, `DECISIONS.md:67`), os 4.957 endereços
em 328 exchanges no commit `9f61b0d` (`DECISIONS.md`), e a afirmação de que 0
classes e 0 scores mudaram nos 30 quando a lista de CEX entrou.
