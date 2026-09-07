> **Note for English readers.** This file is in Portuguese: it is the execution
> briefing for the security finding the Hackathon Web3 Global #02 jury raised
> (the gate spends Blockscout credit on payments nobody signed), received on
> 2026-09-05 as a handoff document. It is kept verbatim as a working record.
> **Nothing in it has been executed**: the owner froze all changes to this
> repository on 2026-09-06 pending the jury's complete feedback. The English
> account of how the gate works today is in [`ARCHITECTURE.md`](ARCHITECTURE.md);
> the audit that sits next to this fix is [`AUDIT-2026-09.md`](AUDIT-2026-09.md).
> The briefing's item 1 is answered there: production runs `src/server.ts`.

# KYA — Briefing de execução do fix de segurança x402

Documento de handoff. Cole no Claude Code dentro do repo `kya-know-your-agent`.
Contém tudo que foi apurado: diagnóstico confirmado, escopo aprovado, escopo
recusado, e os pontos de verificação.

---

## 0. Prompt de abertura (cole isto primeiro)

> Estou retomando o fix de segurança do KYA. Segue o briefing completo do que já
> foi diagnosticado e decidido. Não refaça a análise, ela está confirmada.
> Não crie PLAN.md. Execute na ordem: (1) responda o item 1 do briefing,
> (2) escreva o teste #6 e me mostre ele vermelho, (3) aplique a Opção A,
> (4) me mostre o teste verde, (5) corrija os quatro pontos de documentação.
> Um passo de cada vez, pare e me mostre o resultado antes de avançar.
>
> [colar o resto deste arquivo]

---

## 1. PRIMEIRA COISA A RESPONDER (bloqueia a urgência)

**Qual arquivo o Railway sobe em produção?**

Verificar em `package.json` (script `start`), `railway.json` / `railway.toml`,
`Procfile`, ou `Dockerfile`.

- Se o entrypoint é **`src/server.ts`** → o serviço publicado tem budget diário
  de 500 (`src/server.ts:244`). A exposição real é a demo e o design da lib.
  É dívida de design, não incêndio. Fix continua valendo, urgência cai.
- Se **`demo/paid-endpoint.ts`** está exposto → urgente hoje, a cota está aberta
  para qualquer um na internet.

Responder isso antes de escrever qualquer linha.

---

## 2. Diagnóstico confirmado

### A ordem invertida

| Linha | O que roda |
|---|---|
| `demo/paid-endpoint.ts:112` | `app.use(kyaGate())` — **chama o Blockscout aqui** |
| `demo/paid-endpoint.ts:116` | `app.use(paymentMiddleware(...))` — valida assinatura e prazo aqui |
| `demo/paid-endpoint.ts:135` | `app.get('/chem', ...)` |

A validação x402 existe e é real, mas acontece 63 linhas e um round-trip depois
de o gate já ter gastado a cota.

Confirmado lendo o pacote instalado:
- `node_modules/x402-express/dist/esm/index.mjs:172` → `await verify(decodedPayment, selectedPaymentRequirements)`
- `node_modules/x402-express/dist/esm/index.mjs:230` → `next()` só depois disso

### O caminho até a rede, a partir do header não autenticado

```
src/gate.ts:99      payerFromPaymentHeader(header)
src/gate.ts:107     await check(payer)
src/verify.ts:80    loadHistory
src/history.ts:164  fetchAddressHistory
src/blockscout.ts:455-464  → 6 requisições HTTP (7 se /counters vier frio)
```

### O header forjado mínimo

Não precisa de `scheme`, `network`, `signature`, `validBefore`. Só isto:

```json
{"payload":{"authorization":{"from":"0x1111111111111111111111111111111111111111"}}}
```

Base64:
```
eyJwYXlsb2FkIjp7ImF1dGhvcml6YXRpb24iOnsiZnJvbSI6IjB4MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMSJ9fX0=
```

### O agravante que muda o tamanho do problema

`app.use(kyaGate())` está montado **sem path**, então roda em toda requisição.
Já o `paymentMiddleware` só age em `GET /chem` — `index.mjs:26`:
`if (!matchingRoute) return next()`.

**Consequência:** `GET /qualquer-coisa` com header forjado gasta 6 chamadas ao
Blockscout e devolve 404. O atacante nem precisa mirar a rota paga, e nessa
variante o `paymentMiddleware` não chega sequer a reclamar.

Por isso **reordenar sem escopar não fecha o buraco**.

### A causa: raciocínio incompleto, não descuido

`src/gate.ts:13-18` e `DECISIONS.md:59` documentam a decisão: "um `from` forjado
nunca liquida". Isso está **correto** — o gate protege o vendedor de settlement
indevido.

O que o argumento não cobre é **custo**. Ele responde "quem pode ser cobrado" e
fica em silêncio sobre "quem pode me fazer gastar". Autorização e custo são
gates diferentes. A banca achou o buraco entre as duas perguntas.

### Superfície real: proteções invertidas em relação ao risco

| | `GET /verify` (`src/server.ts:294`) | `kyaGate()` (`src/gate.ts:88`) |
|---|---|---|
| Proteção x402 | nenhuma, rota pública | header forjável |
| Budget diário | sim, `src/server.ts:244` (default 500) | **não** |
| Cache 10 min | sim, `src/history.ts:160` | sim (mesmo cache) |
| Degrada p/ fixture | sim | não, 503 |

A frase que fecha o diagnóstico está no próprio código, `src/server.ts:92-93`:

> "This guards the public HTTP surface only. `src/gate.ts` runs inside a
> seller's own process, against their own key, and is deliberately left alone."

O guarda foi construído onde o header forjado não chega, e deixado de fora onde
ele chega. A premissa "a chave é do vendedor" não se sustenta no deploy do
Railway, onde a chave é do Orlando.

### Aritmética do ataque

100.000 créditos/dia ÷ 20 = 5.000 chamadas ÷ 6 por verify ≈ **715 verifies**.
`acquireSlot()` (`src/blockscout.ts:210`) limita a 4 req/s process-wide, então
5.000 chamadas saem em **~21 minutos**. Bate com o já estimado em
`DECISIONS.md:272`.

### O que NÃO amplia a superfície (já verificado, não mexer)

- `?explain=1` — `src/server.ts:232` só liga um booleano; `explain()` (`:143-162`)
  é aritmética pura sobre o breakdown que já existe. Zero requisições extras.
- `?offline=1` — `src/history.ts:144-155`, não toca rede. É saída, não entrada.
- `express.static` (`src/server.ts:298`) — não toca Blockscout.

---

## 3. Duas coisas que NÃO são correção (importante)

A recomendação inicial incluía as duas abaixo. **Ambas caem.**

- **Cache por endereço** — já existe (`src/history.ts:158-162`, TTL 10 min) e é
  estruturalmente inútil contra este ataque: o atacante varia o endereço, todo
  request é miss. Endereços válidos são infinitos e de graça (não precisam
  existir on-chain). Isso já estava escrito em `src/server.ts:72-73`.
- **Rate limit por IP** — reduz a vazão, não fecha nada. Um atacante com header
  forjado continua gastando a cota, só que mais devagar. E é contornável a
  custo baixo.

São defesa em profundidade, não correção. Ficam **fora do escopo de hoje**.

> ⚠️ Se `docs/SECURITY-FIX-PLAN.md` já existe no repo, verificar se ele não
> codifica essas duas como se fossem o fix. Se codificar, corrigir ou substituir
> por este briefing.

---

## 4. A correção aprovada: Opção A

```ts
app.use(paymentMiddleware(receiver, { 'GET /chem': {...} }, { url: facilitatorUrl }))
app.get('/chem', kyaGate(), handler)   // gate ESCOPADO, não app.use()
```

**O que muda:** ~10 linhas em `demo/paid-endpoint.ts`. Nenhuma linha em `src/gate.ts`.

**Critério de aceitação:** nenhuma chamada ao Blockscout para uma requisição cujo
pagamento não foi validado.

### Por que a claim do produto sobrevive (verificado, não é opinião)

`node_modules/x402-express/dist/esm/index.mjs:232`:

```js
next();
await endPromise;
if (res.statusCode >= 400) {
  // devolve o corpo bufferizado e retorna — SEM settle
  return;
}
const settleResponse = await settle(...)   // linha 249, só chega aqui se < 400
```

Um 403 do gate rodando **depois** do `paymentMiddleware` continua não liquidando
nada. O agente recusado continua pagando zero. A claim está intacta e agora é
demonstrável na linha 232 de uma dependência, em vez de depender da ordem dos
`app.use`.

### Riscos ao fluxo legítimo (já checados)

- O `paymentMiddleware` intercepta `res.write`/`res.end`/`writeHead` até liquidar.
  O 403 do gate é bufferizado e reemitido nas linhas 238-243. ✅ Funciona.
- `res.setHeader` **não** é interceptado, então o `X-KYA-Verdict` (`src/gate.ts:123`)
  continua chegando. ✅ Funciona.
- Mudança real de comportamento: um agente recusado agora custa um round-trip ao
  facilitator. É custo do vendedor, não da cota do Blockscout. ✅ Aceitável.

### Opções descartadas (não reabrir)

- **Opção B — gate valida assinatura sozinho.** `x402/schemes` só exporta
  `decodePayment`/`encodePayment`. `x402/facilitator` exporta um `verify` completo
  mas exige `viem ConnectedClient` com RPC (é chamada de rede do mesmo jeito, e
  ainda faz checagem de saldo on-chain). EIP-3009 na mão com viem: um mismatch
  sutil de domínio EIP-712 rejeita pagador legítimo em silêncio. 1-2 dias, risco
  alto, código criptográfico novo. **Não.**
- **Opção C — gate chama o facilitator antes do Blockscout.** `useFacilitator`
  está em `x402/verify`, mas o gate precisaria dos `paymentRequirements` que o
  x402-express constrói nas linhas 44-100. Duplicar isso é receita de drift
  silencioso e dobra as chamadas ao facilitator. Meio dia, sem vantagem sobre A.
  **Não.**

---

## 5. Reprodução antes de codar (30 segundos, custo zero)

Contador local no lugar do Blockscout. Contagem exata, zero créditos gastos.

```js
// scratchpad/blockscout-counter.mjs
import { createServer } from 'node:http'
let n = 0
createServer((req, res) => {
  console.log(`${++n}  ${req.url.slice(0, 90)}`)
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ status: '1', message: 'OK', result: [], transactions_count: '0' }))
}).listen(9999, () => console.log('contador do blockscout na :9999'))
```

```fish
# terminal 1
node scratchpad/blockscout-counter.mjs

# terminal 2 — endpoint em modo LIVE, apontado para o contador
env BLOCKSCOUT_API_URL=http://localhost:9999 BLOCKSCOUT_API_KEY=dummy npm run demo:endpoint

# terminal 3 — header forjado, endereço aleatório, ZERO assinatura
set ADDR 0x(openssl rand -hex 20)
set HDR (printf '{"payload":{"authorization":{"from":"%s"}}}' $ADDR | base64 -w0)

curl -sS -D- "http://localhost:4021/chem?q=x" -H "X-PAYMENT: $HDR" | head -20

# a variante que nem passa perto da rota paga:
curl -sS -o /dev/null -w '%{http_code}\n' "http://localhost:4021/nem-existe" -H "X-PAYMENT: $HDR"
```

**Esperado:** o terminal 1 conta até 6 em cada curl. O segundo curl devolve 404 —
e mesmo assim gastou as 6.

---

## 6. O teste #6 (vermelho antes, verde depois)

Um teste só. `node:test`, no estilo do #5 que já existe.

```ts
/* ── 6 ─────────────────────────────────────────────────────────────────────
 * O gate não pode gastar crédito do Blockscout por um pagamento que ninguém
 * assinou. Vermelho antes da correção, verde depois.
 */
test('um X-PAYMENT forjado chega ao Blockscout zero vezes', async () => {
  const BLOCKSCOUT = 'http://127.0.0.1:59999'   // nada escuta aqui: chamada = falha
  let blockscoutCalls = 0
  let facilitatorSaysValid = false

  const realFetch = globalThis.fetch
  globalThis.fetch = ((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith(BLOCKSCOUT)) {
      blockscoutCalls += 1
      return Promise.resolve(Response.json({ status: '1', message: 'OK', result: [] }))
    }
    return realFetch(input, init)
  }) as typeof fetch

  // app com o paymentMiddleware REAL do x402-express, apontado para um stub
  // facilitator local cujo isValid é controlado por facilitatorSaysValid,
  // e o kyaGate REAL (sem verify injetado: o caminho de produção).

  // 1. FORJADO: facilitator recusa -> 402, e o gate nunca roda.
  assert.equal(refused.status, 402)
  assert.equal(blockscoutCalls, 0, 'o gate gastou crédito por um pagamento não assinado')

  // 2. CONTROLE: pagamento válido -> o gate roda, senão a asserção 1 é vaga.
  facilitatorSaysValid = true
  await fetch(url, { headers: { [PAYMENT_HEADER]: header } })
  assert.ok(blockscoutCalls > 0, 'um pagador legítimo tem que chegar ao Blockscout')
})
```

### Detalhes que decidem se o teste vale alguma coisa

- **Endereço aleatório por execução** (`0x` + 20 bytes). Com endereço fixo, a
  asserção 1 passaria por cache hit — pelo motivo errado.
- **O controle é obrigatório.** `blockscoutCalls === 0` também passa se a rota
  der 404 por qualquer outro motivo. O teste #5 já usa essa disciplina
  (`test/kya.test.ts:188`). Manter.
- **Header bem formado o bastante** para `exact.evm.decodePayment` e
  `findMatchingPaymentRequirements` não rejeitarem antes — senão o controle
  nunca chega ao gate. A forma completa já existe em `demo/agents.ts:139-157`.
  Reaproveitar.
- **`KYA_OFFLINE` desligado** neste teste (o resto da suíte roda offline).
  Salvar e restaurar em `finally`.
- **Aresta:** o caminho do controle escreve em `data/cache/<addr>.json`
  (`src/history.ts:167`), e `CACHE_DIR` é `const` (`src/history.ts:29`), não
  configurável. Ou `rmSync` no `finally`, ou tornar o diretório configurável.
  Teste que suja o repo apodrece. Escolher um dos dois e seguir.

---

## 7. Os quatro pontos de documentação a corrigir

Depois do fix, estas quatro afirmações ficam **falsas** e precisam ser reescritas:

1. `src/gate.ts:1-38`
2. `DECISIONS.md:59`
3. `README.md:148`
4. `docs/CODE-REFERENCE.md:333`

**A distinção exata:**
- ❌ "o gate responde antes do x402-express rodar" → agora é falso
- ✅ "quem é recusado não paga" → continua verdadeiro (garantido por
  `x402-express/index.mjs:232`, não pela ordem dos `app.use`)

Num repo que cuida de precisão de doc, essa é metade do trabalho.

---

## 8. FORA DE ESCOPO HOJE (anotar em TODO, não implementar)

Tudo abaixo é bom e nada disso é o fix:

- Budget diário estendido ao gate (a máquina existe em `src/server.ts:95-140`;
  é a defesa em profundidade de maior retorno por linha, mas fica para depois)
- Cache negativo curto por endereço
- `CACHE_DIR` configurável (a menos que seja a solução escolhida no item 6)
- Reclassificar `NoFixtureError` (`src/history.ts:61`): herda de `BlockscoutError`,
  então em modo offline um payer sem fixture cai no ramo upstream
  (`src/gate.ts:109`) e o 503 devolve a lista de endereços com fixture
  (`src/history.ts:67-71`). É enumeração de fixtures, não vazamento de credencial,
  e `src/server.ts:225,269` já expõe fixtures de propósito. Registrado, não urgente.
- Rate limit por IP (o que menos entrega)

---

## 9. A chave do Blockscout NÃO vaza (verificado, não reinvestigar)

| Canal | Verificação |
|---|---|
| URL | `v2Url` e `etherscanUrl` (`src/blockscout.ts:236-243`) não incluem a chave. Só header `authorization: Bearer ${apiKey}` (`:258`). Intenção declarada em `:246`. |
| Exceção | Nenhuma interpola `apiKey`. `:276` cita o **nome** da env var, não o valor. `:263` interpola `(cause as Error).message`. `:281` interpola status/statusText. `:317` interpola texto do upstream. |
| Log | `src/server.ts:273,277` e `src/gate.ts:111` logam `error`/`error.message`. Nada carrega a chave. |
| Resposta de erro | `src/gate.ts:112-118` devolve `detail = error.message`. Não contém a chave. |

---

## 10. Decisão pendente: a bifurcação da demo

**O achado:** a vulnerabilidade e o caminho feliz da demo são o mesmo mecanismo.

- `demo/agents.ts:16-18` e `:96-97` — no modo padrão, o agente `established`
  (o que precisa dar 200, o clímax da apresentação) paga com header sintético
  **não assinado**, porque o endereço é de terceiro e a chave não é do Orlando.
- `demo/paid-endpoint.ts:75-78` — o facilitator stub responde `isValid: true`
  para qualquer coisa.

**Consequência:** depois da correção, no modo simulado a demo continuará
parecendo não corrigida. O fix só é demonstrável contra o facilitator real
(`--real`) ou apertando o stub.

### As opções

- **(a)** Demo passa a exigir `DEMO_ESTABLISHED_PRIVATE_KEY` para o `established`.
  Recomendação do Claude Code local. Contra: mata justamente o que a banca
  elogiou ("qualquer pessoa abre, sem carteira, e entende por que a nota é aquela").
- **(b) RECOMENDADA — declarar em vez de mudar.** Default continua simulado, mas
  a saída imprime rótulo explícito de que o facilitator stub aceita qualquer
  assinatura, e o README documenta a linha do modo `--real`. Converte "o demo
  simula a liquidação por padrão" (defeito apontado pela banca) em decisão
  declarada. **5 minutos, não um dia.**
- **(c)** Flag de modo no gate. Complexidade sem ganho.

**Decidir depois do fix, não antes.** Não bloqueia o commit.

---

## 11. Ordem de execução e checkpoints

| # | Passo | Como sei que passou |
|---|---|---|
| 1 | Identificar entrypoint do Railway | Resposta explícita: `src/server.ts` ou `demo/paid-endpoint.ts` |
| 2 | Reproduzir com o contador local (§5) | Terminal 1 conta 6 por curl, inclusive no 404 |
| 3 | Escrever o teste #6 | Roda e **falha**, com a mensagem "o gate gastou crédito..." |
| 4 | Aplicar Opção A (§4) | `~10 linhas` em `demo/paid-endpoint.ts`, zero em `src/gate.ts` |
| 5 | Rodar o teste #6 | **Verde**, e o controle (asserção 2) também passa |
| 6 | Rodar a suíte inteira | Nenhuma regressão |
| 7 | Corrigir os 4 pontos de doc (§7) | Nenhuma menção sobrevivente à ordem antiga |
| 8 | Commit único | Mensagem descreve o quê e o porquê, sem inflar |

**Um commit.** A bifurcação da demo e a defesa em profundidade são commits
separados, depois.

---

## 12. Contexto do projeto (para quem abrir isto sem memória)

**KYA — Know Your Agent.** Lê o histórico on-chain de um endereço na Base e emite
um veredito de reputação assinado antes de o pagamento x402 liquidar. Três eixos
em média geométrica ponderada (funding provenance 0.40, maturity 0.35, volume 0.25),
limiares calibrados em 30 endereços rotulados, gate de sanções binário fora do
score, atestado EIP-191. Sem contrato, sem LLM, por decisão de design.

- Repo: `github.com/orlandol23/kya-know-your-agent`
- Produção: `kya-know-your-agent-production.up.railway.app`
- Stack: TypeScript/Node, tsx, viem, express, `x402-express@1.2.0`,
  `x402-fetch@1.2.0`, Blockscout Pro API (free tier, Base chain 8453)

**Origem deste fix:** Hackathon Web3 Global #02 da Borderless (09-22/08/2026).
KYA ficou em 2º de 3 times, 64,5/100. A banca (Yuri, Alex Miloski, Jimmy Tan,
João Soares) apontou como **prioridade nº 1**:

> "Verificar a assinatura x402 antes de disparar consultas externas caras: hoje
> dá para queimar cota da API com headers forjados. Depois, decidir entre levar
> a reputação para on-chain ou ajustar a mensagem."

Decisão já tomada sobre a segunda parte: **ajustar a mensagem**, não levar
on-chain. Off-chain com atestado EIP-191 é escolha deliberada e será declarada
por escrito.

---

## 13. A frase que vale para entrevista

> O argumento antigo respondia "quem pode ser cobrado" e ficava em silêncio
> sobre "quem pode me fazer gastar". Autorização e custo são gates diferentes.

Recebi feedback de segurança de uma banca e corrigi em dias, com teste que
falhava antes e passa depois.
