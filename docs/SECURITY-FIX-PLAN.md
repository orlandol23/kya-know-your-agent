# Security fix plan: the gate spends Blockscout credit on unsigned payments (Plano de correção: o gate gasta crédito do Blockscout com pagamento não assinado)

> **Note for English readers.** This file is in Portuguese: it is the detailed,
> commit-by-commit plan that accompanies
> [`SECURITY-FIX-BRIEFING.md`](SECURITY-FIX-BRIEFING.md),
> received on 2026-09-05 and kept verbatim as a working record. The briefing
> supersedes it where the two differ (the briefing was written after it and
> narrows the scope: per-address cache and per-IP rate limiting are defence in
> depth, not the fix). **Nothing in it has been executed**; changes to this
> repository are frozen pending the jury's complete feedback.
>
> The dependency re-audit (the two highs are axios and ws, both transitive
> through `x402-express`) is recorded in
> [`AUDIT-2026-09.md`](AUDIT-2026-09.md); it is separate from this plan and
> nothing here fixes it.
>
> **Escopo.** Este arquivo é plano de execução, não documentação corrente, e sai
> do repositório quando os três commits estiverem feitos. `PLAN.md` é registro
> histórico do hackathon e não tem relação com este documento.
>
> Origem: falha reportada por escrito pela banca do Borderless Hackathon Web3
> #02. Análise feita em 01/09/2026 contra o commit `25b817e`, com os números
> conferidos rodando o código e lendo `node_modules/x402-express@1.2.0`, não
> recordados.
>
> **Este arquivo é autossuficiente.** Escrito para ser executado numa sessão
> nova, sem o contexto da conversa que o gerou. A seção 1 tem as premissas que
> não estão no código.

---

## 0 · A falha, em uma tela (The failure, in one screen)

`kyaGate()` chama o Blockscout a partir de um header `X-PAYMENT` que ninguém
assinou, porque roda antes do `paymentMiddleware` que valida assinatura e prazo.

Ordem hoje, em `demo/paid-endpoint.ts`:

|Linha|O que roda|
|---|---|
|`demo/paid-endpoint.ts:112`|`app.use(kyaGate())`, **e o Blockscout é lido aqui**|
|`demo/paid-endpoint.ts:116`|`app.use(paymentMiddleware(...))`, valida assinatura aqui|
|`demo/paid-endpoint.ts:135`|`app.get('/chem', ...)`|

Caminho até a rede: `gate.ts:99` → `gate.ts:107` → `verify.ts:80` →
`history.ts:164`
→ `blockscout.ts:455`, que são **6 requisições HTTP** (7 com `/counters` frio).

O header forjado mínimo que o `payerFromPaymentHeader` aceita, verificado
rodando a função:

```json
{"payload":{"authorization":{"from":"0x1111111111111111111111111111111111111111"}}}
```

Sem `scheme`, sem `network`, sem `signature`, sem `validBefore`.

**Agravante.** `app.use(kyaGate())` está montado sem path, então roda em toda
requisição, enquanto o `paymentMiddleware` só age em `GET /chem`
(`x402-express/dist/esm/index.mjs:26`, `if (!matchingRoute) return next()`).
Logo `GET /rota-que-nao-existe` com header forjado gasta 6 chamadas e devolve
404. **Reordenar sem escopar a rota não fecha o buraco.**

**Custo do ataque.** 100.000 créditos/dia ÷ 20 = 5.000 chamadas ÷ 6 por verify
≈ 715 verifies. O `acquireSlot()` (`blockscout.ts:210`) limita a 4 req/s
process-wide, então a cota do dia sai em ~21 minutos. O cache não protege: é
indexado por endereço (`history.ts:158`), e variar o endereço é grátis.

### O que a correção NÃO precisa consertar

O raciocínio original está registrado em `gate.ts:13-18` e `DECISIONS.md:59`, e
**está correto sobre o que ele afirma**: um `from` forjado nunca liquida. Ele
respondia "quem pode ser cobrado" e ficava em silêncio sobre "quem pode me
fazer gastar". A banca achou o buraco entre as duas perguntas.

Registrar como raciocínio incompleto, não como bug. A propriedade de segurança
que o gate protegia continua verdadeira depois da correção, e passa a ter uma
fundamentação melhor (seção 3.4).

---

## 1 · Premissas: o que não está no código (Assumptions not in the code)

Ler antes de começar. Cada item já causou, ou causaria, retrabalho.

### 1.1 Convenções do repositório

- **Sem travessão.** `README.md`, `DECISIONS.md` e os três arquivos de `docs/`
  têm **zero** caracteres `—` e `–` (conferido: commit `b570bf4`, *"docs:
  replace
  em dashes with the punctuation the rest of the repo uses"*). Use dois pontos,
  vírgula ou parênteses. Confira antes de fechar cada commit:

  ```bash
  # (não incluir docs/*.md: este plano contém os caracteres de propósito)
  grep -c '—\|–' README.md DECISIONS.md \
    docs/ARCHITECTURE.md docs/CODE-REFERENCE.md docs/POSITIONING.md   # 0 em todos
  ```

- **Títulos bilíngues.** `DECISIONS.md` e `PLAN.md` usam `## English
  (Português)`
  no título e corpo em português. `README.md`, `docs/ARCHITECTURE.md` e
  `docs/POSITIONING.md` são em inglês. `docs/CODE-REFERENCE.md` é em português.
  Ao editar, siga o idioma do arquivo, não o desta conversa.
- **Comentário explica POR QUÊ, não o quê.** Todo docstring do repo justifica
  uma
  decisão e cita o número medido. Mantenha o registro ao reescrever.

### 1.2 Ambiente e ferramentas

- Node >= 22. `npm test` é `tsx --test`, que descobre `test/kya.test.ts`
  sozinho.
- **Rodar sempre da raiz do repositório**: `data/fixtures/` é resolvido contra o
  cwd (`test/kya.test.ts:9`).
- **`git commit` está bloqueado por hook nesta máquina.** Não tente rodar. Os
  comandos prontos para colar estão em 3.7, 4.4 e 5.4.
- O `.env` da raiz tem chaves reais (`BLOCKSCOUT_API_KEY`,
  `ATTESTER_PRIVATE_KEY`). **Não imprimir, não colar em log, não commitar.**
- O shell do dono é `fish`. Os blocos marcados ```fish usam sintaxe fish.

### 1.3 Coisas do código que mordem

- **`test/kya.test.ts:23-25` seta `ATTESTER_PRIVATE_KEY` no topo do módulo**,
  com
  o comentário *"Set before any verify() runs: attesterAccount() reads the env
  at
  call time"*. O teste #6 mexe em variáveis de ambiente: se mexer antes dessa
  linha, ou não restaurar, **quebra os testes 1 a 5**. Restaure tudo no
  `finally`.
- **`isOffline()` lê `process.env.KYA_OFFLINE` na hora da chamada**
  (`history.ts:79`) e `setOffline()` muta `process.env` (`:83-86`). Não há
  estado
  em módulo: dá para ligar e desligar dentro de um teste, desde que restaure.
- **`main()` roda no import** em `demo/paid-endpoint.ts:156`. Importar o módulo
  num teste sobe um servidor. É o motivo do passo 3.2.
- **A suíte inteira roda offline** contra as fixtures commitadas. O teste #6 é o
  primeiro que precisa do caminho ao vivo, com a rede stubada.

### 1.4 Estado de partida

Baseline conferido em 01/09/2026 contra `25b817e`: `npm test` dá **5 passes, 0
falhas**, `npm run typecheck` sai limpo, e `git status --short` mostra só dois
arquivos novos não rastreados: `docs/CODE-REFERENCE.md` e este arquivo.

O `docs/CODE-REFERENCE.md` não rastreado é **trabalho anterior, sem relação com
este plano**. Não o inclua nos commits abaixo. Decida o destino dele separado.

### 1.5 Decisões já tomadas (01/09/2026)

Não reabrir sem motivo novo.

|#|Decisão|Por quê|
|---|---|---|
|1|**Opção A** (reordenar + escopar a rota), não validação de assinatura no gate|Verificado no código do `x402-express` que a claim sobrevive (3.4). As alternativas exigem cripto nova ou duplicar a construção dos `paymentRequirements`|
|2|**Extrair `buildPaidEndpoint()`** no commit 1|Sem ela o teste #6 não consegue ficar vermelho, e commits 1 e 2 ficam inseparáveis (3.2)|
|3|**Demo passa a exigir `DEMO_ESTABLISHED_PRIVATE_KEY`**|É a única opção em que a tela mostra o que o código faz|
|4|**Rate limit por IP fica de fora**|Reduz vazão sem fechar nada, e é contornável barato|
|5|**Documentação dividida por executável vs. descritivo**|Ver 3.5. O critério anterior ("falso vs. impreciso") não sobreviveu à releitura|
|6|**`CACHE_DIR` configurável** no commit 1|Teste que suja o repo apodrece|
|7|**Fresh offline: opção A**, par de chaves novo com fixture real e chave descartável commitada|A alternativa exigia imprimir um aviso de que aquele modo não valida assinatura, ou seja, uma demo que afirma segurança sem exercer: o problema da banca movido de lugar. E contradiria a decisão 3, aplicando dois critérios opostos na mesma tela. Detalhe em 7.3|

---

## 2 · Passo 0: baseline verde (Step 0: green baseline)

```bash
npm test && npm run typecheck && git status --short
```

**Ponto de verificação.** Tem que aparecer:

``` text
# tests 5
# pass 5
# fail 0
```

typecheck sem nenhuma saída (exit 0), e `git status --short` mostrando
**apenas**
`?? docs/CODE-REFERENCE.md` e `?? docs/SECURITY-FIX-PLAN.md`. Qualquer outro
arquivo modificado: pare e resolva antes de começar.

---

## 3 · Commit 1: a correção (Commit 1: the fix)

**Escopo:** Opção A (reordenar + escopar), extração do `buildPaidEndpoint()`,
teste #6 vermelho antes e verde depois, `CACHE_DIR` configurável, e a
documentação executável. Nada mais.

### 3.1 Tornar `CACHE_DIR` configurável

**Arquivo:** `src/history.ts`

`CACHE_DIR` é `const` em `:29` e é usado em `:67`, `:150`, `:158`, `:167`. É
exportado, mas **nada fora de `src/history.ts` importa** (conferido com grep), o
que torna a mudança contida.

Trocar por uma função que lê o ambiente na hora da chamada, que é o idioma que o
resto do código já usa (`apiUrl()` em `blockscout.ts:155`, `chainId()` em
`:163`,
`dailyVerifyBudget()` em `server.ts:97`):

```ts
const DEFAULT_CACHE_DIR = 'data/cache'

/** Onde as entradas de cache moram. Configurável para que um teste não suje o repo. */
export function cacheDir(): string {
  return process.env.KYA_CACHE_DIR?.trim() || DEFAULT_CACHE_DIR
}
```

Atualizar os quatro usos. Atenção ao `:67`: a mensagem do `NoFixtureError`
interpola `CACHE_DIR`, e precisa virar `cacheDir()`.

Documentar `KYA_CACHE_DIR` no `.env.example`, junto de `KYA_OFFLINE`.

**Ponto de verificação:**

```bash
npm run typecheck && npm test && grep -rn "CACHE_DIR" src/ | grep -v DEFAULT_CACHE_DIR
```

`# pass 5`, `# fail 0`, typecheck limpo, e o grep **sem nenhuma saída**.
Qualquer
`CACHE_DIR` restante fora do `DEFAULT_` é um uso que escapou.

### 3.2 Extrair `buildPaidEndpoint()`

**Arquivo:** `demo/paid-endpoint.ts`

**Por que este passo existe.** Sem ele o teste #6 é teatro. `test/kya.test.ts`
monta o próprio app express (é o que o teste #5 faz em `:158-166`), então um
teste que monte o app já corrigido testa a fiação do próprio teste, nunca fica
vermelho, e não prova nada. E apontar o teste para o binário real como
subprocesso **também não resolve**: o facilitator stub do demo responde
`isValid: true` para qualquer coisa (`demo/paid-endpoint.ts:75-78`), então mesmo
depois da correção o gate roda e o teste segue vermelho até o commit 2. Os dois
commits ficariam inseparáveis.

Mover `:106-143` para uma função exportada, **sem mudar a ordem ainda**:

```ts
export type PaidEndpointOptions = {
  payTo: Address
  facilitatorUrl: `${string}://${string}`
  /** Sobe o stub local. False quando o chamador traz o próprio facilitator. */
  withStubFacilitator?: boolean
}

export function buildPaidEndpoint(options: PaidEndpointOptions): express.Express {
  // exatamente o corpo de hoje, ordem inalterada
}
```

`main()` passa a chamar `buildPaidEndpoint({...})` e só cuida de env, log e
`listen`. **`main()` roda no import hoje** (`:156`), e precisa continuar rodando
para o `npm run demo:endpoint`, mas o teste importa só `buildPaidEndpoint`.
Guardar a chamada com uma checagem de entrypoint, ou mover `main()` para outro
arquivo.

**Ponto de verificação:**

```bash
npm run typecheck && npm test && npm run demo:endpoint:offline
```

`# pass 5`, `# fail 0`, e o servidor sobe imprimindo as quatro linhas de sempre
(`price`, `settlement`, `reputation`, `waiting for agents...`). **Este passo não
pode mudar nada observável.** Ctrl+C para sair.

### 3.3 Escrever o teste #6, e vê-lo VERMELHO

**Arquivo:** `test/kya.test.ts`, no fim, seguindo a numeração e o estilo dos
cinco
existentes.

```ts
/* ── 6 ─────────────────────────────────────────────────────────────────────
 * O gate não pode gastar crédito do Blockscout por um pagamento que ninguém
 * assinou. A cota do tier gratuito é finita e não tem dono: quem forja um
 * header gasta o crédito de graça. Vermelho antes da correção, verde depois.
 */
test('a forged X-PAYMENT header reaches Blockscout zero times', async () => {
  // ...
})
```

Elementos que decidem se o teste vale alguma coisa:

- **Endereço aleatório por execução** (`0x` + 20 bytes de `randomBytes`). Com
  endereço fixo, a asserção passaria por *cache hit*, pelo motivo errado.
- **`KYA_CACHE_DIR` apontado para `mkdtempSync()`**, removido no `finally`. É
  para isso que 3.1 existe.
- **`KYA_OFFLINE` desligado** neste teste e restaurado no `finally`: o resto da
  suíte roda offline e o teste #6 precisa do caminho ao vivo. Ver 1.3.
- **Contagem por stub do `globalThis.fetch`**, deixando passar tudo que não for
  o
  host do Blockscout (o próprio teste usa `fetch` contra `127.0.0.1`). Restaurar
  o `fetch` original no `finally`.
- **`paymentMiddleware` REAL do `x402-express`**, apontado para um facilitator
  do
  próprio teste com `isValid` controlável. Não mockar o middleware: é a ordem
  dele que está sendo testada.
- **Header bem formado o bastante** para `exact.evm.decodePayment` e
  `findMatchingPaymentRequirements` aceitarem, senão o controle nunca chega ao
  gate. A forma completa já existe em `demo/agents.ts:129-159`, reaproveitar.
- **O controle é obrigatório.** `blockscoutCalls === 0` também passa se a rota
  der 404 por qualquer outro motivo. É a disciplina que o teste #5 já usa em
  `test/kya.test.ts:188`.

|Caso|Facilitator|Antes da correção|Depois da correção|
|---|---|---|---|
|header forjado|recusa|gate roda, **6 chamadas**, VERMELHO|402, **0 chamadas**, VERDE|
|header válido (controle)|aceita|gate roda, >0 chamadas|gate roda, >0 chamadas|

**Ponto de verificação, e este é o mais importante do plano:**

```bash
npm test 2>&1 | tail -30
```

Tem que aparecer:

``` text
# tests 6
# pass 5
# fail 1
```

E a falha tem que ser **exatamente** a asserção de contagem, com a mensagem
`o gate gastou crédito por um pagamento não assinado` e `actual: 6`.

Se falhar com outra coisa (timeout, `ECONNREFUSED`, erro de tipo, ou `actual: 0`
na asserção de controle), **o teste está errado, não o código.** Conserte o
teste
antes de seguir. Um teste que fica vermelho pelo motivo errado fica verde pelo
motivo errado.

### 3.4 Aplicar a correção

**Arquivo:** `demo/paid-endpoint.ts`, dentro de `buildPaidEndpoint()`

```ts
// 1. x402: 402 com os requisitos quando não há pagamento; verifica a assinatura
//    aqui, e só liquida depois que o handler responder 2xx.
app.use(paymentMiddleware(receiver, { 'GET /chem': { ... } }, { url: facilitatorUrl }))

// 2. Quem está pagando, e o que já fez. Escopado na rota paga: montado com
//    app.use() genérico, rodaria também nas rotas que o paymentMiddleware
//    ignora, e o buraco continuaria aberto.
app.get('/chem', kyaGate(), (_req, res) => { ... })
```

**Por que a claim do produto sobrevive**, verificado no código da dependência,
`node_modules/x402-express/dist/esm/index.mjs`:

```js
next();                          // linha 230
await endPromise;
if (res.statusCode >= 400) {     // linha 232
  // devolve o corpo bufferizado e retorna, SEM settle
  return;
}
const settleResponse = await settle(...)   // linha 249, só com status < 400
```

Um 403 do gate rodando **depois** do `paymentMiddleware` continua não liquidando
nada. E a garantia fica mais forte do que era: antes dependia de o vendedor
lembrar de montar na ordem certa, agora é o fluxo de controle do próprio
`x402-express` que a impõe.

Duas checagens já feitas, para não precisar refazer:

- o `paymentMiddleware` intercepta `res.write`/`res.end`/`writeHead` até
  liquidar, e o 403 do gate é bufferizado e reemitido nas linhas 238-243.
- `res.setHeader` **não** é interceptado, então o `X-KYA-Verdict`
  (`gate.ts:123`) continua chegando ao cliente.

**Ponto de verificação:**

```bash
npm test && npm run typecheck
```

``` text
# tests 6
# pass 6
# fail 0
```

E a reprodução manual da seção 6 tem que passar a contar **0** onde contava 6.

### 3.5 Documentação executável

**O critério, e por que ele mudou.** A primeira versão deste plano dividia os
pontos em "vira falso" e "vira impreciso". **Esse rótulo estava errado.** Numa
releitura estrita, os 14 pontos viram falsos: os que pareciam apenas imprecisos
usam palavra direcional que inverte (`ARCHITECTURE.md:25` diz *"mounts **in
front
of** the x402 payment middleware"*, `:150` diz *"the payment middleware
**behind** it"*, `CODE-REFERENCE.md:333` diz *"o x402-express **logo atrás**
verifica"*). O que aquela divisão media era quanto texto muda, não verdade.

O critério que vale: **o que alguém pode executar, e o que sustenta a segurança,
entra aqui. O que só descreve vai para o commit 3.** Um bloco de código com
`app.use(kyaGate())` antes do `paymentMiddleware` são instruções copiáveis que
reproduzem a falha reportada. Uma linha de tabela errada, não.

|#|Local|O que está lá|Por que no commit 1|
|---|---|---|---|
|1|`src/gate.ts:3-6`|exemplo de montagem com `kyaGate()` em primeiro|copiável|
|2|`src/gate.ts:8-11`|*"The order is the whole point... it never runs at all if this middleware answers first"*|é a justificativa de segurança|
|3|`src/gate.ts:13-18`|o raciocínio da assinatura, *"the payment middleware **downstream**"*|idem. Redação em 3.6|
|4|`DECISIONS.md:55-59`|título **e** corpo. O título `## The gate runs before the payment middleware` é a afirmação|é o registro da decisão. Redação em 3.6|
|5|`README.md:140-150`|bloco de código + *"The order is the mechanism"*|o bloco mais copiado do repo|
|6|`docs/CODE-REFERENCE.md:332-337`|*"Por que o gate lê o header sem verificar assinatura"*|é a justificativa de segurança|
|7|`docs/ARCHITECTURE.md:129-136`|*"Why the 403 lands before settlement"* + bloco de código|copiável|
|8|`docs/ARCHITECTURE.md:96-127`|**o diagrama ASCII grande**, com `[1] kyaGate()` em duas posições|é o artefato mais olhado do arquivo, e está de ponta a ponta errado|
|9|`docs/ARCHITECTURE.md:25-30`|*"mounts **in front of**"*, *"Because it sits in front"*|é a definição do produto em um parágrafo: se ela está errada, tudo abaixo herda|
|10|`docs/POSITIONING.md:118-125`|*"mounts **in front of**"* + bloco de código|copiável|
|11|`demo/paid-endpoint.ts:10-18`|docstring `Middleware order is the product`|é o arquivo que está sendo corrigido|

**Ponto de verificação:**

```bash
grep -rn "in front of\|order is the\|A ordem é o\|nunca liquida\|never runs\|runs before\|roda antes\|logo atrás\|downstream" \
  README.md DECISIONS.md docs/ARCHITECTURE.md docs/CODE-REFERENCE.md docs/POSITIONING.md \
  src/gate.ts demo/paid-endpoint.ts | grep -v SECURITY-FIX-PLAN
```

Hoje esse grep devolve **26 linhas**. Tem que voltar só o que você reescreveu de
propósito, mais os pontos 12 a 19 que ficaram para o commit 3, mais o ruído
abaixo. Qualquer bloco de código ou parágrafo de justificativa ainda dizendo que
o gate roda antes é ponto que escapou. Rode antes de fechar o commit, não
depois.

**Ruído conhecido, não tocar.** O padrão pega cinco linhas que falam de outra
coisa:

|Linha|Sobre o que é de verdade|
|---|---|
|`DECISIONS.md:106`|`lookupCex` roda antes da heurística, classificação de funding|
|`docs/CODE-REFERENCE.md:55`|o compliance gate roda antes do score|
|`docs/CODE-REFERENCE.md:372`|`lookupCex` de novo|
|`docs/POSITIONING.md:208`|"in front of a real seller's paid endpoint", sobre deploy|
|`docs/POSITIONING.md:405`|"a trusted oracle in front of it", sobre score on-chain|

E a checagem de travessão da seção 1.1:

```bash
grep -c '—\|–' README.md DECISIONS.md \
  docs/ARCHITECTURE.md docs/CODE-REFERENCE.md docs/POSITIONING.md   # 0 em todos
```

### 3.6 A redação para o `DECISIONS.md`

O ponto 4 da tabela. Título novo, porque o antigo é a própria afirmação
corrigida. Segue a convenção bilíngue da seção 1.1:

> ## The gate runs between payment verification and settlement (O gate roda entre a verificação e a liquidação do pagamento)
>
> A entrada anterior dizia que o gate roda **antes** do middleware de pagamento,
> e que não conferir a assinatura sobre o campo `from` era seguro porque um
> `from` forjado nunca liquida.
>
> A parte sobre liquidação estava certa e continua certa. O raciocínio era
> **incompleto**: respondia "quem pode ser cobrado" e ficava em silêncio sobre
> "quem pode me fazer gastar". Um header forjado nunca liquidava, e mesmo assim
> disparava seis chamadas ao Blockscout, contra uma cota gratuita e finita que
> não tem dono. Reportado pela banca do hackathon.
>
> A ordem passou a ser `paymentMiddleware` → `kyaGate` → handler, com o gate
> escopado na rota paga. A propriedade não mudou: `x402-express` só liquida com
> status abaixo de 400 (`index.mjs:232`), então um 403 do gate continua
> significando que o agente recusado pagou zero. O que mudou é o que a sustenta.
> Antes era a ordem de montagem, que o vendedor podia errar em silêncio. Agora é
> o fluxo de controle do próprio `x402-express`.
>
> O gate deixou de estar "na frente do x402" e passou a estar **dentro dele**,
> na
> janela entre verificar e liquidar. É onde ele sempre pertenceu.

### 3.7 Fechar o commit 1

`git commit` está bloqueado por hook. Comando pronto para colar:

```bash
git add src/history.ts demo/paid-endpoint.ts test/kya.test.ts src/gate.ts \
        README.md DECISIONS.md docs/ARCHITECTURE.md docs/CODE-REFERENCE.md \
        docs/POSITIONING.md .env.example
git commit -m "fix: the gate no longer spends Blockscout credit on unsigned payments

kyaGate() read the payer out of an X-PAYMENT header and called Blockscout
before x402-express validated the signature, so a forged header spent the
free tier's daily credit at no cost to the attacker. Reported by the
hackathon jury.

The gate now mounts behind paymentMiddleware and is scoped to the paid
route: mounted with a bare app.use() it also ran on the routes the payment
middleware ignores, which is the same hole by another door.

The product claim survives, on a better footing. x402-express settles only
below status 400 (index.mjs:232), so a 403 from the gate still means the
refused agent paid nothing. That used to rest on mount order, which a
seller could get wrong silently; it now rests on x402-express's own
control flow.

Test 6 counts Blockscout calls behind a forged header and asserts zero,
with a valid payer as the control. buildPaidEndpoint() was extracted so
the test can reach the real wiring: without it the test cannot go red.
CACHE_DIR became configurable via KYA_CACHE_DIR so the test does not write
into data/cache/.

Docs that someone could copy, or that carry the security argument, are
updated here. Descriptive tables and the small flow diagram follow in the
hardening commit."
```

**Não incluir `docs/CODE-REFERENCE.md` se ele ainda estiver não rastreado por
outro motivo.** Ver 1.4.

---

## 4 · Commit 2: a demo passa a exigir chave real (Commit 2: the demo requires a real key)

**Por que existe.** A vulnerabilidade e o caminho feliz da demo são o mesmo
mecanismo. Em modo padrão o agente **established**, o que precisa dar 200, paga
com header sintético não assinado (`demo/agents.ts:96-97`), porque o endereço é
de terceiro e a chave não é nossa. E o facilitator stub aprova qualquer coisa
(`demo/paid-endpoint.ts:75-78`).

Consequência: depois do commit 1, **em modo simulado a demo continua parecendo
não corrigida**. O stub aprova, o gate roda. A correção só é demonstrável contra
o facilitator real, ou apertando o stub.

### 4.0 O agente fresh offline: resolvido pela seção 7

O caminho offline é o que sobrevive à Blockscout cair, e **não pode quebrar**.

O fresh em offline usa hoje o caminho sintético (`demo/agents.ts:102`,
`key: undefined`). Se passar a assinar com chave gerada na hora, o gate procura
fixture para o endereço derivado dessa chave, que não existe, e responde **503
em
vez de 403**: a demo offline perde o desfecho.

**Resolvido pela opção A** (seção 7.2): par de chaves novo, chave guardada,
fixture real capturada. Execute a seção 7.2 **antes** do passo 4.1.3.

### 4.1 Passos

1. **Apertar o stub facilitator** (`demo/paid-endpoint.ts:75-78`): recusar
   payload cuja `signature` seja o placeholder de 65 bytes zerados, devolvendo
   `{ isValid: false, invalidReason: ... }`. Não precisa validar EIP-3009 de
   verdade: basta parar de aceitar o que ninguém assinou.
2. **`demo/agents.ts`**: remover o ramo sintético do established (`:96-97` e
   `syntheticFetchWithPayment` em `:125-159`), exigindo
   `DEMO_ESTABLISHED_PRIVATE_KEY` também fora do `--real`. Sem a chave, imprimir
   a mesma linha de skip que o `--real` já imprime em `:99`.
3. **Aplicar a decisão de 4.0** para o fresh offline.
4. **`.env.example`**: `DEMO_ESTABLISHED_PRIVATE_KEY` deixa de ser "`--real`
   only"
   e vira requisito da demo.
5. **`README.md` e `docs/ARCHITECTURE.md`**: a demo tem pré-requisito novo.

### 4.2 Ponto de verificação

```bash
npm test && npm run typecheck
```

`# pass 6`, `# fail 0`, typecheck limpo. Depois, sem a chave configurada:

```bash
npm run demo:endpoint    # terminal 1
npm run demo:agents      # terminal 2
```

O terminal 2 tem que imprimir a linha de skip do established e rodar só o fresh,
terminando em 403. **Não pode dar exceção nem status inesperado.**

Com `DEMO_ESTABLISHED_PRIVATE_KEY` configurada: os dois agentes rodam,
established 200, fresh 403, e o terminal 1 mostra as duas linhas `[kya]`.

### 4.3 O ponto de verificação que não pode falhar

```bash
npm run demo:endpoint:offline    # terminal 1
npm run demo:agents:offline      # terminal 2
```

Tem que terminar com o fresh em **403**, não 503. Um 503 significa que o gate
não
achou fixture, e que a decisão de 4.0 não foi aplicada corretamente.

### 4.4 Fechar o commit 2

```bash
git add demo/ .env.example README.md docs/ARCHITECTURE.md data/fixtures/
git commit -m "demo: the established agent must sign, not send a synthetic header

The reported vulnerability and the demo's happy path were the same
mechanism: in simulated mode the established agent paid with an unsigned
X-PAYMENT header, and the stub facilitator approved anything. So after the
ordering fix the demo still showed the gate reading Blockscout behind an
unsigned header, which is precisely what was fixed.

The stub now refuses the all-zero placeholder signature, and the demo
requires DEMO_ESTABLISHED_PRIVATE_KEY instead of standing in for a key it
does not have. The screen now shows what the code does."
```

---

## 5 · Commit 3: budget compartilhado e documentação descritiva (Commit 3: shared budget and descriptive docs)

**Defesa em profundidade, não correção.** Rate limit por IP fica de fora
(decisão 4 da seção 1.5).

### 5.1 Budget compartilhado com o gate

O que existe hoje: `server.ts:95-140` tem a máquina completa (contador em
processo, reset na virada do dia UTC, `KYA_DAILY_VERIFY_BUDGET`, aviso uma vez
por dia), e `server.ts:92-93` diz explicitamente que o gate foi deixado de fora,
com a premissa de que a chave é do vendedor. **No Railway a chave é sua**, e é
essa premissa que não se sustenta.

1. Extrair `server.ts:95-140` para `src/budget.ts`, sem mudança de
   comportamento.
2. `server.ts` passa a importar. **A suíte tem que continuar verde aqui**, antes
   de ligar no gate.
3. `kyaGate()` consulta o budget antes de `check(payer)` (`gate.ts:107`).
4. Sem budget, o gate responde **503**. `server.ts` degrada para fixture, mas o
   gate é fail-closed por desenho (`DECISIONS.md:65-70`) e essa assimetria é
   deliberada: servir fixture velha como veredito de pagamento é pior que
   recusar.
5. `.env.example`: `KYA_DAILY_VERIFY_BUDGET` passou a valer para os dois.

### 5.2 Documentação descritiva

Os pontos que sobraram de 3.5: descrevem, ninguém copia.

|#|Local|O que está lá|
|---|---|---|
|12|`docs/CODE-REFERENCE.md:148-155`|diagrama de fluxo pequeno + *"A ordem é o produto"*|
|13|`docs/CODE-REFERENCE.md:38`|linha da tabela com a ordem de montagem|
|14|`docs/ARCHITECTURE.md:83`|linha da tabela: `kyaGate()` → `paymentMiddleware()` → `GET /chem`|
|15|`docs/ARCHITECTURE.md:150`|linha da tabela, *"The payment middleware **behind** it does check"*|
|16|`test/kya.test.ts:143-148`|docstring do teste #5: *"a 403 from the gate lands BEFORE the payment middleware"*. **O teste continua passando** (monta o próprio app e testa o gate isolado), mas a premissa escrita fica falsa. Reescrever para o que ele de fato prova: um 403 do gate impede que o que vem atrás rode|
|17|`src/gate.ts:26-34`|parágrafo sobre requisição sem header passar direto. Sob a fiação nova esse ramo (`gate.ts:93-97`) fica inalcançável no demo, porque o `paymentMiddleware` responde 402 antes. O ramo continua correto para quem monta o gate de outro jeito: **não remover o código**, só dizer que no demo não é mais o caminho|
|18|`DECISIONS.md`|entrada nova sobre o budget passar a valer para o gate, e por que ele responde 503 em vez de degradar|
|19|`docs/ARCHITECTURE.md:523`|*"KYA sits **in front of** it and changes nothing about it"*, onde "it" é o protocolo x402. Depois da correção o KYA está **dentro** do fluxo do x402, na janela entre verificar e liquidar. A segunda metade da frase ("changes nothing about it") continua verdadeira e é o que importa ali|

### 5.3 Ponto de verificação

```bash
npm test && npm run typecheck
```

Verde. Depois, com budget zerado:

```bash
KYA_DAILY_VERIFY_BUDGET=0 npm run demo:endpoint
```

Um pagador legítimo tem que receber **503**, e o contador de chamadas ao
Blockscout (seção 6) tem que ficar em **0**. Se ele receber 200, o budget não
está no caminho do gate.

E o grep final, que agora tem que voltar **vazio**:

```bash
grep -rn "in front of\|order is the\|A ordem é o\|never runs\|runs before\|roda antes\|logo atrás" \
  README.md DECISIONS.md docs/ARCHITECTURE.md docs/CODE-REFERENCE.md docs/POSITIONING.md \
  src/*.ts demo/*.ts test/*.ts | grep -v SECURITY-FIX-PLAN
```

### 5.4 Fechar o commit 3

```bash
git add src/ demo/ test/ docs/ DECISIONS.md .env.example
git commit -m "harden: the daily verify budget now covers the gate too

server.ts guarded the public /verify surface and left the gate alone, on
the premise that the gate runs in a seller's process against a seller's
key. On the public deployment that key is ours, so the premise does not
hold. The budget moved to src/budget.ts and both paths charge it.

Out of budget the gate answers 503 rather than replaying a fixture:
serving a stale capture as a payment verdict is worse than refusing, and
fail-closed is already the gate's documented posture.

Rate limiting by IP was considered and left out: it lowers throughput
without closing anything and is cheap to work around.

Descriptive docs (tables, the small flow diagram, test 5's docstring)
catch up with the ordering fix here."
```

---

## 6 · Reprodução manual (Manual reproduction)

Para ver a falha antes de corrigir, e a correção depois. Custo zero: o contador
substitui o Blockscout.

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

# terminal 2
env BLOCKSCOUT_API_URL=http://localhost:9999 BLOCKSCOUT_API_KEY=dummy npm run demo:endpoint

# terminal 3, fish
set ADDR 0x(openssl rand -hex 20)
set HDR (printf '{"payload":{"authorization":{"from":"%s"}}}' $ADDR | base64 -w0)

curl -sS -o /dev/null -w 'chem:        %{http_code}\n' "http://localhost:4021/chem?q=x" -H "X-PAYMENT: $HDR"
curl -sS -o /dev/null -w 'inexistente: %{http_code}\n' "http://localhost:4021/nem-existe" -H "X-PAYMENT: $HDR"
```

||Antes do commit 1|Depois do commit 1|
|---|---|---|
|contador no terminal 1|conta até **12** (6 por curl)|fica em **0**|
|`/chem`|403 com atestado assinado|402, pedindo pagamento|
|`/nem-existe`|404, e gastou 6 assim mesmo|404, sem gastar nada|

---

## 7 · O agente fresh em modo offline: DECIDIDO, opção A (The fresh agent offline: decided)

**Decisão tomada em 01/09/2026. Não reabrir.** A justificativa está em 7.3, e é
mais forte do que a recomendação que a precedeu: leia antes de reconsiderar.

### 7.1 O problema

Em offline, o fresh usa o caminho sintético (`demo/agents.ts:102`,
`key: undefined`) porque só precisa de um endereço, não de uma chave. O commit 2
remove esse caminho. Se o fresh passar a assinar com uma chave gerada na hora, o
gate em offline procura `data/fixtures/<endereço derivado>.json`, que não
existe,
e responde **503** (`history.ts:155` → `gate.ts:109`) em vez do **403** que a
demo precisa mostrar.

Fixture e chave estão amarradas: o `from` do header é o endereço da chave que
assinou, então não dá para assinar com uma chave e apresentar outro endereço.

### 7.2 A decisão: opção A, par de chaves novo com fixture real

Gerar um par de chaves novo, capturar a fixture de verdade do Blockscout, e
commitar a chave privada como descartável.

O fresh passa a assinar de verdade em todo modo, e recebe um 403 de verdade. Um
caminho de código só. A fixture é captura datada real de um endereço real e
vazio, coerente com o `NOTE` de `history.ts:56-58`.

**Passos:**

1. Gerar o par e **guardar a chave** (o `0xeB94Dd…6B97` de hoje teve a chave
   descartada no D2, que é o motivo de ele não servir):

   ```bash
   node -e "import('viem/accounts').then(a => { const k = a.generatePrivateKey(); console.log(k, a.privateKeyToAccount(k).address) })"
   ```

2. Capturar a fixture do endereço novo, uma vez, ~6 créditos:

   ```bash
   npx tsx scripts/capture.ts <endereço>
   ```

   Conferir que o arquivo caiu em `data/fixtures/<endereço>.json` e que o
   `captured_at` é de hoje.

3. A chave vai para `.env.example` como `DEMO_FRESH_PRIVATE_KEY`, com o mesmo
   tipo de comentário alto que o `ATTESTER_PRIVATE_KEY` já tem: **descartável,
   nunca segurou fundos, existe só para a demo offline assinar de verdade**.
4. `demo/agents.ts`: o ramo offline (`:101-103`) passa a usar essa chave em vez
   de `FRESH_FIXTURE_ADDRESS` com `key: undefined`.
5. O `0xeB94Dd…6B97` **continua no repositório**: é um dos quatro casos do teste
   #2 (`test/kya.test.ts:72`, score 0). Não remover, só deixar de ser o agente
   da
   demo.

**Ponto de verificação:** é o 4.3. `npm run demo:agents:offline` tem que
terminar
com o fresh em **403**, e `npm test` tem que continuar com os quatro fixtures do
teste #2 intactos.

**Custo:** ~1 hora, mais 6 créditos de Blockscout.

**O contra, registrado:** uma chave privada commitada num repositório cujo
assunto
agora é uma falha de segurança. É por isso que o comentário do passo 3 não é
opcional: um revisor apressado vê "private key" no diff e tira a conclusão
errada.
O precedente existe e é do próprio repo, `test/kya.test.ts:24`.

### 7.3 Por que a opção B foi rejeitada

A alternativa era manter o caminho sintético só em `--offline`, com o stub
permissivo, e imprimir na tela um aviso de que aquele modo não valida
assinatura.
Ela tinha um argumento de mérito real, e é por isso que fica registrada: em
offline o gate lê fixtures e nunca toca a rede (`history.ts:144-155`), então não
existe cota do Blockscout para queimar, e a falha reportada não tem impacto
naquele modo.

**Foi rejeitada mesmo assim, e o motivo é o próprio custo dela.** Exigir um
aviso
impresso de que aquele modo não valida assinatura deixa uma demo que **afirma
segurança sem exercer**, que é exatamente o problema que a banca achou, apenas
movido de lugar. E contradiz a decisão 3 da seção 1.5 (a demo passa a exigir
`DEMO_ESTABLISHED_PRIVATE_KEY`), tomada justamente porque era a única em que a
tela mostra o que o código faz. Escolher B para o fresh depois de escolher (a)
para o established seria aplicar dois critérios opostos ao mesmo problema, na
mesma tela.

Um híbrido (B agora, A no backlog) foi considerado e descartado junto: item de
backlog desse tipo não é limpo.

---

## 8 · Backlog: prioridade baixa (Low priority)

### 8.1 O 503 do `NoFixtureError` enumera as fixtures

`NoFixtureError extends BlockscoutError` (`history.ts:61`). Em modo offline, um
payer sem fixture cai no ramo `upstream` do gate (`gate.ts:109`) e o **503
devolve ao cliente a lista de endereços que têm fixture** (`history.ts:67-71`,
ecoado por `gate.ts:117`).

Não é vazamento de credencial. `server.ts:225` e `:269` já expõem `fixtures` de
propósito, então talvez seja aceito. O que é discutível é a **classificação**:
falta de fixture não é falha de upstream, e o gate responde 503 por um problema
de configuração local. `docs/CODE-REFERENCE.md:401` já registra a herança, mas
pela ordem dos `catch`, não por isso.

Fora do escopo dos três commits. Registrado para não se perder.

### 8.2 A chave do Blockscout: conferida, não vaza

Verificado em 01/09/2026 nos quatro canais, sem ação necessária:

|Canal|Verificação|
|---|---|
|URL|`v2Url` e `etherscanUrl` (`blockscout.ts:236-243`) não incluem a chave. Só header, `:258`. Intenção declarada em `:246`|
|Exceção|nenhuma mensagem interpola `apiKey`. `:276` cita o **nome** da variável, não o valor|
|Log|`server.ts:273,277` e `gate.ts:111` logam `error.message`, que não a contém|
|Resposta HTTP|`gate.ts:112-118` devolve `detail` ao cliente, sem a chave|

Se alguma dessas linhas mudar, refazer a conferência.
