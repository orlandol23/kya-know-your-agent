# KYA v0.1 · Plano de implementação

```
Projeto      KYA (Know Your Agent), verificação de reputação de agentes no fluxo x402
Autor        Orlando Fernandes de Lima e Silva · solo
Janela       09/08 a 22/08/2026 · D1 = 13/08 · entrega 22/08
Orçamento    ~14h de código (40% dev / 60% apresentação)
Stack        TypeScript, Node, tsx, viem, express, x402-express, x402-fetch
Dados        Blockscout Pro API, Base mainnet (chain 8453)
```

**O produto em três frases.** Agentes de IA já pagam por serviços via x402, mas o provedor não tem como saber quem está do outro lado. Sem identidade verificável, ele só pode bloquear todo agente ou aceitar qualquer um. A solução é reputação derivada do track record on-chain do agente, verificada antes de liberar o recurso.

---

# 1 · Estrutura do repositório

```
kya/
├── README.md
├── package.json            viem, express, x402-express, tsx, typescript. Nada além.
├── tsconfig.json
├── .env.example            BLOCKSCOUT_API_KEY, ATTESTER_PRIVATE_KEY (descartável), PORT
├── .gitignore              .env, node_modules, data/cache/
├── data/
│   ├── addresses.csv       30 endereços rotulados: a entrada da calibração
│   └── signals.csv         gerado por collect.ts e COMMITADO: é a evidência
├── scripts/
│   ├── collect.ts          lê addresses.csv, chama Blockscout, escreve signals.csv
│   └── calibrate.ts        lê signals.csv, distribuição por grupo, limiares sugeridos
├── src/
│   ├── config.ts           env + limiares calibrados, com a tabela de percentis em comentário
│   ├── blockscout.ts       as 3 chamadas limitadas + retry/backoff + tipos da resposta
│   ├── signals.ts          txs -> { age, volume, diversity, cadence }
│   ├── score.ts            sinais -> 0..100, linear por sinal com clamp
│   ├── verdict.ts          score -> trusted | unknown | suspicious
│   ├── attest.ts           serialização canônica + assinatura EIP-191 (viem)
│   ├── verify.ts           pipeline address -> attestation (CLI, server e gate usam este)
│   ├── cli.ts              npx tsx src/cli.ts 0x...  -> atestado no terminal
│   ├── server.ts           GET /verify?address= e serve ui/ estática
│   └── gate.ts             middleware: decodifica X-PAYMENT, 403 se suspicious
├── demo/
│   ├── paid-endpoint.ts    endpoint pago x402 protegido pelo gate (a demo dos 20s)
│   └── agents.ts           2 clientes x402-fetch: wallet nova vs wallet com histórico
└── ui/
    └── index.html          tela dividida, 2 painéis, consome /verify. Cortável.
```

## As 3 chamadas do [fetch]

Não é paginação completa. São três chamadas limitadas, com custo constante:

```
1. txlist sort=asc & page=1 & offset=1      primeira tx = IDADE   (Etherscan-compatible)
2. /addresses/{addr}/transactions            até 3 páginas (150 tx)
                                             = DIVERSIDADE + RITMO
3. /addresses/{addr}/counters                transactions_count = VOLUME
```

Custo por verify: 3 a 5 requests, independente do tamanho do endereço. Diversidade e ritmo ficam **janelados** nas últimas ≤150 transações, e isso é declarado no atestado.

---

# 2 · Plano por dia

Cada dia cabe num Bloco Inegociável de 2h.

| Dia | Data | Entrega funcionando ao fim | Cortável se atrasar |
|---|---|---|---|
| **D1** | 13/08 | Scaffold + `blockscout.ts` + `collect.ts` para 1 endereço: os 4 sinais impressos no terminal | Nada. É a fundação. |
| **D2** | 14/08 | `addresses.csv` com 30 endereços + `signals.csv` + `calibrate.ts` imprimindo percentis + limiares gravados em `config.ts` | Reduzir para 20 endereços |
| **D3** | 15/08 | `score` + `verdict` + `cli.ts`: veredito para qualquer endereço | Nada |
| **D4** | 16/08 | `attest.ts` + `server.ts`: `curl /verify?address=` devolve atestado assinado, com snippet de verificação no README | Nada |
| **D5** | 17/08 | `gate.ts` + `demo/`: wallet nova recebe 403, wallet com histórico paga e recebe 200. Timebox de 1h para x402 real; fallback é header sintético | Settlement real |
| **D6** | 18/08 | `ui/index.html`: dois painéis, badge de veredito, 4 sinais, link de evidência | Animações |
| **D7** | 19/08 | Modo `--offline` com fixtures funcionando, endereço com 0 tx, endereço inválido, README final | **`--offline` NÃO é cortável.** É a rede de segurança da demo ao vivo. |
| **D8** | 20/08 | Ensaio da demo ao vivo, ponta a ponta, cronometrado. Gravar um vídeo de backup para tocar caso a demo falhe no dia. | |
| **D9** | 21/08 | Segundo ensaio, roteiro dos 10 minutos fechado, ambiente da apresentação testado (Meet, compartilhamento de tela, terminal legível). **Tudo pronto ao fim deste dia.** | |
| **D10** | 22/08 | **APRESENTAÇÃO ÀS 10h BRT no Google Meet.** Não é dia de trabalho. | |

**Ordem de corte global:** animações da UI, depois a UI inteira (demo vira CLI + curl no vídeo), depois settlement real (header sintético).

**Stories da semana 1 vencem sábado 15/08.** Story 1 = tabela de calibração (D2). Story 2 = CLI mostrando trusted vs suspicious (D3). Fecha a obrigação sem esforço extra.

---

# 3 · Plano de commits

```
Regras   2 a 4 commits por bloco
         commit quando algo RODA, não quando um arquivo é salvo
         push diário
         tag v0.1.0 no D9
         mensagens em inglês, formato `type: entrega`
```

Sequência esperada:

```
chore: project scaffold with typescript and tsx
feat: fetch age, volume, diversity and cadence signals from Blockscout (3 bounded calls)
feat: signal collection script for a labeled address set
data: calibration set of 30 labeled Base addresses with provenance
feat: calibration report with per-group percentiles and suggested thresholds
data: extracted signals for the calibration set
feat: deterministic 0-100 score from calibrated thresholds
feat: trusted/unknown/suspicious verdict with cutoffs read from the data
feat: EIP-191 signed attestation with verifiable Blockscout evidence link
feat: GET /verify returns a signed attestation
feat: x402 gate rejects suspicious payers with 403 before settlement
demo: paid endpoint on Base Sepolia protected by the KYA gate
demo: two agents side by side, fresh wallet blocked, established wallet served
feat: split-screen UI comparing two agents
feat: offline mode replaying cached fixtures
docs: README with 60-second overview and demo instructions
```

`git log --oneline --reverse` vira a linha do tempo do pitch e a pauta dos stories, e prova que tudo foi escrito dentro da janela oficial.

---

# 4 · Metodologia de calibração

O objetivo: quando perguntarem "por que 70 e não 60?", a resposta é lida dos dados, não defendida no grito.

## a) Composição do conjunto: 3 estratos de 10, com proveniência registrada

```
established   10 EOAs com atividade sustentada na Base.
              Fonte A: compradores reais de x402 (token-transfers de USDC RECEBIDOS
                       por um seller ou facilitator conhecido; o campo `from` é o
                       comprador). Colheita no navegador.
              Fonte B: se nenhum endereço completo estiver acessível, EOAs ativos
                       genéricos da Base (últimos blocos no Blockscout). Válido
                       porque o sinal é track record on-chain, não pertencimento
                       ao x402.

fresh         10 endereços sem lastro. 3 gerados por você agora (histórico zero
              garantido) + 7 com primeira tx há menos de 7 dias, achados nos
              blocos recentes.

mid           10 intermediários: semanas de idade com pouca diversidade, ou
              atividade em rajada. É o estrato que estressa a fronteira.
```

**Rotule pelo observável** (established, fresh, mid), nunca por "bom" ou "mau". Não existe ground truth de malícia: o score mede histórico, não intenção. Igual antispam. Diga isso no pitch antes que um juiz diga para você.

## b) Colunas do CSV

```
addresses.csv    address, label, provenance, notes

signals.csv      address, label, first_seen, age_days, tx_count,
                 distinct_counterparties, txs_24h, txs_7d,
                 fetched_at, blockscout_url
```

## c) Derivação dos limiares

Cada sinal vale 0 a 25 pontos, com pesos iguais por decisão (v0.1 não tem número mágico; aprender pesos é marco futuro).

```
pts(x) = clamp((x - ZERO) / (FULL - ZERO), 0, 1) * 25

ZERO = p75 do grupo fresh          abaixo disso, indistinguível de wallet nova
FULL = p25 do grupo established    a partir daqui, típico de endereço estabelecido
```

`calibrate.ts` imprime min, p25, p50, p75 e max por sinal por grupo, e os ZERO/FULL resultantes. Você confere no olho, cola a tabela como comentário em `config.ts` e commita.

**O limiar é output do repositório, não input.**

## d) Cortes de veredito

Rode o score sobre os 30 endereços com os limiares acima. Os cortes vão no **vão vazio entre os clusters**:

```
SUSPICIOUS_MAX = maior score do grupo fresh (ou o teto do vão acima dele)
TRUSTED_MIN    = menor score do grupo established (ou o piso do vão abaixo dele)
```

`calibrate.ts` fecha imprimindo a tabela de separação: quantos de cada grupo caíram em cada veredito. A meta honesta: 10 de 10 established viram trusted, 10 de 10 fresh viram suspicious, e o grupo mid se distribui entre unknown e as bordas.

## e) A resposta pronta para a pergunta do juiz

> "O corte fica no vão entre os clusters do conjunto de referência. Os valores exatos saem de `npx tsx scripts/calibrate.ts`, que qualquer um roda em cima do `signals.csv` commitado."

## f) Honestidades a declarar de saída

```
n=30 é conjunto de referência, não estatística
diversidade e ritmo são janelados nas últimas ≤150 transações
mede histórico, não intenção
```

Nenhuma delas enfraquece a v0.1 se você as disser primeiro.

**Timebox: 2 blocos.** D2 inteiro, com transbordo máximo de 30 min no D3. Refinar limiar infinitamente é o padrão nº 1 do mapa de autossabotagem com outro nome.

---

# 5 · Esqueleto do README

Escrito em inglês, para leitura em 60 segundos.

````markdown
# KYA — Know Your Agent

**On-chain reputation for AI agents that pay through x402.**

AI agents already buy services with stablecoins over x402 (7M+ transactions as
of Aug 2026). The seller sees a valid payment and nothing else: no history, no
way to tell an established agent from a wallet created five minutes ago. Even
x402's own explorer only indexes the seller side.

KYA answers the missing question: **who is this agent, and what has it done?**

## What it does

    GET /verify?address=0x...

Returns a signed attestation: `{ verdict, score, signals, evidence, issued_at,
signature }`.

- **Deterministic.** 4 signals from the agent's Base history: age, volume,
  counterparty diversity, recent cadence. No LLM anywhere in the pipeline.
- **Calibrated, not invented.** Thresholds are derived from a labeled reference
  set of 30 real addresses. `scripts/calibrate.ts` reproduces every number.
- **Verifiable without trusting this API.** `evidence` links to the raw history
  on Blockscout. `signature` is EIP-191; any service checks it in 3 lines:

      const signer = await recoverMessageAddress({ message, signature })
      // signer === KYA attester address -> authentic

## The gate

`kyaGate` is x402 middleware. It reads the payer address from the payment
header and blocks `suspicious` agents with 403 **before settlement**: the
rejected agent pays nothing, the seller risks nothing. `unknown` passes with
an `X-KYA-Verdict` header; blocking it is the seller's choice.

## Try it

    cp .env.example .env    # Blockscout key + throwaway attester key
    npm i
    npx tsx src/cli.ts 0xYourAddress
    npx tsx src/server.ts   # /verify + demo UI

## Deliberately not in v0.1

No LLM. No dangerous-contract list. No agent: this is the verification
primitive, not a wallet with a chatbot. No on-chain verifier yet: the next
milestone is an EIP-712 attestation a Solidity contract can consume.

Built solo in 14 days for the Borderless Web3 hackathon (Aug 2026).
````

---

# 6 · Riscos de execução

**1. Blockscout instável ou com rate limit no dia da demo.**
Como a demo é **ao vivo às 10h do dia 22**, essa é a ameaça número um do projeto. O cache em arquivo que dobra como fixtures e a flag `--offline` deixam de ser opcionais: são a rede de segurança. Gravar um vídeo de backup no D8 para tocar caso tudo falhe ao vivo.

**2. Integração x402 real emperra no D5.**
Pacotes confirmados no npm: `x402-express@1.2.0` e `x402-fetch@1.2.0`, última publicação em 16/04/2026. Ainda assim, timebox de 1h no quickstart. O fallback é indolor por construção: o `kyaGate` roda **antes** do middleware de pagamento e só decodifica o header `X-PAYMENT` (base64 JSON, campo `from`), então um cliente sintético que manda o header exercita exatamente o mesmo código do cliente real.

**3. Endereço da demo não pontua como esperado.**
Trave os 2 endereços da demo dentro da calibração no D2. Para o lado do pagamento: só `suspicious` bloqueia, então uma wallet sua serve mesmo saindo `unknown`. O painel "trusted" da UI usa um endereço established de terceiro, porque o `/verify` é público e não precisa da chave dele.

**4. Testnet trava a demo de pagamento.**
Reputação é lida da Base **mainnet** (8453); o pagamento roda na Base **Sepolia** com a mesma chave, porque o endereço é o mesmo nas duas redes. Providencie no D4: USDC do faucet da Circle e ETH Sepolia para gas nas duas wallets.

**5. UI engole D6 e D7.**
Cap de 4h, HTML estático puro consumindo `/verify`, ordem de corte já definida na seção 2.

**6. `/counters` do Blockscout falhar para algum endereço.**
Reportar `tx_count` como "≥N (janela)" e seguir. O score usa clamp, então não quebra.

---

# 7 · As três decisões

## 1. Contrato verificador on-chain: não fazer na v0.1

A portabilidade já fica provada pelas 3 linhas de `recoverMessageAddress` no README: qualquer stack verifica sem confiar na sua API, hoje.

Contrato on-chain só cria valor quando um **contrato** consome o atestado (escrow, allowlist), e nesse dia o formato certo é **EIP-712**, porque verificar EIP-191 sobre string JSON dentro de Solidity é hostil e caro. Ou seja: as 2h de hoje virariam retrabalho no marco seguinte. E é exatamente o tipo de infraestrutura sem consumidor que o juiz investidor desconta.

Projete verbalmente: *"próximo marco: atestado EIP-712 consumível por contratos"*. Ver a hierarquia de marcos no fim deste documento.

## 2. Runtime: TypeScript e Node, sem disputa

viem cobre assinar e recuperar, os SDKs de x402 são TS-first, e `tsx` elimina build. Qualquer alternativa custa prazo e não compra nada no pitch.

## 3. Persistência: stateless

O atestado é point-in-time: `issued_at` mais uma linha no README ("consumers decide their own freshness policy").

O único armazenamento que se paga: cache JSON em arquivo por endereço com TTL de 10 minutos, cerca de 20 linhas, porque ele dobra como as fixtures do modo `--offline` do risco 1. Sem banco, sem nada.

---

# 8 · Ajustes estruturais em relação ao grafo original

Declarados, não escondidos.

**1. O [fetch] virou 3 chamadas limitadas em vez de paginar tudo.**
Um endereço-baleia com dezenas de milhares de transações estoura latência, rate limit e orçamento. Consequência: diversidade e ritmo são calculados sobre a janela das últimas ≤150 transações, e declarados assim no atestado. Os 4 sinais do grafo permanecem; só a definição fica precisa e o custo por verify fica constante.

**2. O grafo não dizia o que acontece com `unknown` no gate.**
Agora é explícito: passa, com header `X-KYA-Verdict: unknown`, e bloquear vira configuração do provedor. Só `suspicious` toma 403. Sem isso, a sua própria wallet arriscava travar a demo de pagamento.

**3. Framing, não estrutura: o score mede histórico, não intenção.**
Assuma isso na primeira frase técnica do pitch. É a pergunta mais provável do juiz investidor, e ela vira ponto a favor quando é você quem a levanta.

---

# Hierarquia de marcos

O KYA responde duas perguntas. A v0.1 resolve a primeira.

```
v0.1   ESTA ENTREGA    track record -> veredito -> atestado assinado -> gate
                       responde: "o que esse agente já fez?"
                       Trilha A do Miloski. Não depende de ninguém.

v0.2   próximo         atestado em EIP-712, para que um CONTRATO consuma
                       extensão técnica da mesma primitiva

v0.3   depois          credencial ZK ligando o agente a um principal,
                       com escopo de autoridade
                       responde: "em nome de quem ele age?"
                       Trilha B do Miloski.

em paralelo            o teste do comerciante real, que segundo o RFP
                       é a pergunta que sustenta o negócio
```

Cobertura em relação ao RFP: a v0.1 já entrega duas das quatro wedges do KYA Stack (verificação do lado do comerciante, alimentada por reputação agente-a-agente). Credencial de agente e camada de disputa ficam nos marcos seguintes.

---

# Formato e estrutura do pitch

```
QUANDO    22/08/2026, 10h BRT, Google Meet
DURAÇÃO   10 minutos por time
FORMATO   demo AO VIVO remota, compartilhando tela. Não é vídeo gravado.
PLATEIA   banca (Yuri, Miloski, Jimmy) + olheiros do Crypto Valley que assistem
```

Roteiro dos 10 minutos:

```
0:00-1:00   PROBLEMA em linguagem humana, sem jargão
            "o explorador oficial do x402 não deixa consultar um agente"
            alvo: Yuri e os olheiros, que não têm contexto do bootcamp

1:00-5:00   DEMO AO VIVO do core flow
            dois endereços lado a lado, um passa e um é barrado
            alvo: Jimmy

5:00-7:30   COMO FUNCIONA, curto
            os 4 sinais, a calibração medida, o atestado assinado
            "o score mede histórico, não intenção"
            alvo: Miloski

7:30-9:00   POR QUE É UMA SEMENTE + próximo marco
            "KYA responde duas perguntas: o que esse agente já fez, e em nome
             de quem ele age. Em 14 dias resolvi a primeira, que é a que não
             depende de ninguém. A segunda é o próximo marco."
            alvo: Miloski e os olheiros

9:00-10:00  buffer e perguntas
```

Duas regras que vêm do formato ao vivo:

**Nada de referência interna.** Os olheiros não sabem o que é a Trilha A nem quem é o Marko. Toda afirmação precisa se sustentar sozinha, com evidência.

**Terminal legível.** Fonte grande, tema claro, saída limpa. Um terminal ilegível numa call remota mata a demo mais bem construída.

Não precisa ser inventada no D8. D8 é ensaio.

---

# Antes do D1

```
[ ] Testar /counters no navegador e confirmar que devolve transactions_count
[ ] Ler este plano por completo (seções 4, 7 e 8 são as que você vai defender)
```
