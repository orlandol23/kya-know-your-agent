# KYA v0.1 · Plano de implementação

> **Registro histórico do planejamento, não documentação corrente.** O que o
> sistema faz hoje está no `README.md`, em `docs/ARCHITECTURE.md` e em
> `DECISIONS.md`; onde este plano divergir deles, eles é que valem. As seções de
> cronograma, plano de commits, rascunho de README e preparação de apresentação
> foram removidas — o arquivo continua aqui porque código e dados citam suas
> seções de calibração pelo número.

```
Projeto      KYA (Know Your Agent), verificação de reputação de agentes no fluxo x402
Autor        Orlando Fernandes de Lima e Silva · solo
Janela       09/08 a 22/08/2026 · D1 = 13/08 · entrega 22/08
Stack        TypeScript, Node, tsx, viem, express, x402-express, x402-fetch
Dados        Blockscout Pro API, Base mainnet (chain 8453)
```

**O produto em três frases.** Agentes de IA já pagam por serviços via x402, mas o provedor não tem como saber quem está do outro lado. Sem identidade verificável, ele só pode bloquear todo agente ou aceitar qualquer um. A solução é reputação derivada do track record on-chain do agente, verificada antes de liberar o recurso.

---

# ⚠️ Duas correções de rota descobertas no D2 (15/08)

**A janela mudou de rota.** O endpoint v2 `/addresses/{addr}/transactions` devolveu 500 em 23 de 30 endereços durante a coleta. A janela passou a usar `txlist` paginado, que é a mesma rota Etherscan-compatible da chamada 1. Validado: números idênticos nas duas rotas (0x3c95… deu 90 tx / 58 contrapartes pelas duas). Ganho colateral: ~10x mais rápido (2s contra 20s por página) e com páginas numeradas, então as 3 vão em paralelo em vez de seguir cursor. Para uma demo ao vivo, é a diferença entre 2s e 60s por verify.

**`/counters` é computado preguiçosamente.** A primeira chamada num endereço frio devolve 0; uma chamada posterior devolve o valor real. Medido: 51 de 74 endereços mudaram de contagem na segunda leitura, incluindo 0 → 145.793. Regra implementada: contagem menor que o tamanho da janela é impossível (a janela é subconjunto do total), então isso é prova de contador frio e dispara uma releitura. Se ainda divergir, reporta a janela como piso com `txCountExact = false`.

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

## c) Normalização por sinal (os limiares continuam saindo dos dados)

Cada sinal é normalizado para 0..1 com clamp linear entre dois percentis do conjunto de referência:

```
norm(x) = clamp((x - ZERO) / (FULL - ZERO), 0, 1)

ZERO = p75 do grupo fresh          abaixo disso, indistinguível de wallet nova
FULL = p25 do grupo established    a partir daqui, típico de endereço estabelecido
```

`calibrate.ts` imprime min, p25, p50, p75 e max por sinal por grupo, e os ZERO/FULL resultantes. Você confere no olho, cola a tabela como comentário em `config.ts` e commita.

**O limiar é output do repositório, não input.**

## c1) ⭐ RESULTADOS DA CALIBRAÇÃO (medidos em 16/08, n=30)

```
sinal        ZERO (p75 fresh)   FULL (p25 established)   separação    veredito
age_days           3.03                532.09              176x       ✅ usar
tx_count          54.75               2236.25               41x       ✅ usar
diversity          5.75                  6.25              0.09x      ⚠️ não separa
txs_24h           30.25                  7.50             INVERTIDO   ⚠️ não separa
txs_7d            54.75                 41.25             INVERTIDO   ⚠️ não separa
```

> **Rodada de 16/08/2026**, a mesma commitada em `src/config.ts` e derivada de
> `data/signals.csv`. Reproduza com `npx tsx scripts/calibrate.ts`. Substitui a
> rodada de 15/08, que trazia 187x e 35x e ficou aqui depois que o `config.ts`
> já tinha avançado.
>
> Cuidado ao reproduzir: o script imprime **apenas ZERO e FULL**. A coluna
> `separação` é anotação à mão, copiada de `src/config.ts`, e não sai do script.
> Ela também não é uma conta só: `176x` e `41x` são `FULL/ZERO`, enquanto o
> `0.09x` da diversidade é `(FULL-ZERO)/ZERO` (por `FULL/ZERO` seria `1.09x`).
> Os valores estão como `config.ts` os registra; a convenção é que está mista.

**Por que o ritmo inverteu:** wallet fresca de bot dispara 150 transações num dia; endereço estabelecido fica dormente. Ritmo mede **atividade atual, não track record**. Os dados confirmaram, sem saber, o desenho que um mentor do programa já tinha proposto: cadência entra como `cadence_penalty` multiplicativa, não como eixo positivo normalizado.

**Por que a diversidade não separou:** o estrato established contém bots antigos de 1 contraparte (0x016a…, 0xAdC5…), então o p25 caiu para 6 e encostou no p75 do fresh.

**Decisão deliberada: o estrato NÃO foi recomposto para melhorar esses números.** Escolher os established pela diversidade garantiria que a diversidade separasse, o que é calibrar no próprio alvo. Os sinais que não separam ficam declarados como tal.

**Frame de amostragem, para a pergunta "de onde vieram os 30":** EOAs que enviaram USDC na Base nos blocos 50021246 a 50021255, que é a população mais próxima de agentes pagando via x402. Foram medidos 74 candidatos e selecionados por regras declaradas no cabeçalho do `addresses.csv` (as 7 mais novas para fresh, 7 a 90 dias para mid, as 10 mais antigas para established), nenhuma baseada no sinal em calibração. Fora do frame: 3 endereços gerados localmente, o endereço da demo e o vitalik.eth.

## ⭐ Limitação descoberta e a declarar no pitch: relayer e account abstraction

Dos 74 endereços amostrados, **13 têm zero transações mas até 73.598 token transfers**. São carteiras que pagam via relayer ou account abstraction: o `from` do token transfer é elas, mas quem envia a transação é outro endereço.

Pelos sinais da v0.1, um agente desses é **indistinguível de uma carteira criada agora**.

Declare isso antes que um juiz pergunte. E é o argumento mais direto para o funding provenance: o primeiro inbound existe mesmo quando a contagem de transações não existe.

## c2) A função de reputação: média geométrica ponderada

> Fonte: Q&A com um mentor do programa, Week 12 (15/08). Substitui a soma linear de 25 pontos por sinal que estava aqui antes.

```
score = 1000 · G · penalty · confidence

G          = ∏ max(s_k, EPS) ^ w_k          média geométrica dos sinais normalizados
EPS        = 0.02                            piso: um eixo fraco mas não-zero não anula tudo
penalty    = cadence_penalty(...)            multiplicativo, 1.0 quando nada é anômalo
confidence = evidence_mass / (evidence_mass + 25)
             o score "sobe conforme merece": carteira com pouca evidência pontua baixo
             por falta de dados, não por ser julgada má
```

Por que média geométrica e não soma: **um eixo fraco não pode ser compensado por um eixo forte.** Com soma, um agente com funding suspeito compensa com volume alto. Com produto, não compensa. É a forma certa para reputação.

**Pesos, pelo princípio "pese pelo custo de forjar", já ajustados pelo que a calibração mediu:**

```
sinal          peso v0.1   estado          nota
funding          0.40      ⭐ D3           primeiro inbound: CEX vs mixer.
                                           Mais difícil de forjar. Sobe de prioridade
                                           porque diversidade e ritmo caíram.
maturity         0.35      ✅ tem          idade. Separa 176x. Forjável esperando.
volume           0.25      ✅ tem          contagem. Separa 41x. Barato de forjar
                                           com self-sends, por isso o menor peso.
---
contracts         —        roadmap         contrapartes são protocolos rotulados?
ratings           —        roadmap         camada humana, só quem usou pode votar.
familiarity       —        roadmap         contata vendedores x402 com frequência.
```

**Diversidade e ritmo saem da média geométrica.** A calibração mostrou que não separam os grupos (ver c1). Ritmo vira `cadence_penalty` multiplicativa, que é onde ele sempre pertenceu. Diversidade continua sendo **coletada e exibida** no atestado como evidência, mas com peso zero, e isso é declarado. É honesto e é um bom momento de pitch: *"medi e dois sinais não separavam, então não entram na conta."*

**O funding entrou no D3 e é o eixo mais forte da v0.1.** Três listas, com proveniência declarada no código:

```
SANCIONADOS   ⭐ fonte autoritativa. Lista SDN do OFAC, publicação de 07/08/2026,
              100 endereços com idType "Digital Currency Address - ETH",
              15 com atividade real na Base. O gate disparou de verdade num
              endereço do Lazarus Group.
MIXERS        3 contratos do Tornado Cash, verificados lendo o Blockscout na
              chain 1. Ressalva declarada: não estão deployados na Base, então
              o ramo não dispara lá hoje. Lista separada da SDN, e não é a
              mesma categoria de obrigação: a SDN é exigência legal, esta
              denylist é escolha de política do projeto. O Tornado saiu da
              lista SDN em março de 2025 (o co-fundador continua listado).
CEX           ⭐ fonte adotada: Dune Spellbook, modelo cex_evms.addresses, no
              commit pinado 9f61b0d de 28/01/2026, com 4.957 endereços e 328
              exchanges, commitado em data/cex-addresses-evm.json com sha256 e
              licença no bloco meta. O lookupCex roda ANTES da heurística e dá
              identity "confirmed"; o miss cai na heurística e dá "inferred".
              A CLASSE é exchange nos dois caminhos, então nenhum score mudou:
              0 classes e 0 scores mudaram nos 30, verificado contra o
              funding_class commitado no signals.csv.

              A medição real, e não citar cobertura maior que esta: 4 de 30
              endereços dão hit, os quatro pelo MESMO financiador
              0x3304e22d… = Binance 76. São 24 financiadores distintos no
              conjunto e exatamente 1 está na lista.

              A heurística continua como fallback e foi validada por ela: das
              3 wallets que ela classificava como exchange, 2 foram confirmadas
              pelo Dune (Binance 76 e Bybit 6) e a terceira, 0x8581784d…,
              segue "inferred". Não foi refutada, só não foi nomeada.
              ⚠️ Licença BSL 1.1 (Dune Analytics AS, Change Date 2027-03-03).
```

Bug corrigido no caminho: o primeiro inbound de **token** costuma nomear um contrato, não um financiador (um endereço saiu com "funder" 0x4200…0006, que é o WETH da Base). O inbound **nativo** tem precedência; token transfer é fallback só para carteiras que nunca enviaram transação, que é justamente o caso das carteiras de relayer.

`WEIGHTS_WITHOUT_FUNDING` fica no `config.ts` para a troca ser de uma linha, caso o eixo precise sair.

Declare no README qual subconjunto está ativo.

`evidence_mass` na v0.1 = número de transações observadas na janela (0 a 150). É simples, é honesto, e faz a wallet zerada cair naturalmente para score ~0.

**Compliance gate, separado do score e binário:**

```
if funded_by_known_mixer or sanctioned:
    return { score: 0, gated: true }
```

Mixer não pontua mal. Bloqueia. É a diferença entre "suspeito" e "proibido".

**cadence_penalty (multiplicativo, opcional na v0.1):**

```
burst_ratio > 50        × 0.85    p99 da taxa / mediana da taxa
regime_change           × 0.80    mudança abrupta de comportamento (chave comprometida?)
cotiming_corr > 0.9     × 0.60    move em sincronia com um cluster
```

Só o `burst_ratio` é barato de calcular com o que você já busca. Os outros dois são roadmap.

## d) Cortes de veredito

Rode o score sobre os 30 endereços. Os cortes vão no **vão vazio entre os clusters**:

```
SUSPICIOUS_MAX = maior score do grupo fresh (ou o teto do vão acima dele)
TRUSTED_MIN    = menor score do grupo established (ou o piso do vão abaixo dele)
```

`calibrate.ts` fecha imprimindo a tabela de separação: quantos de cada grupo caíram em cada veredito. A meta honesta: 10 de 10 established viram trusted, 10 de 10 fresh viram suspicious, e o grupo mid se distribui entre unknown e as bordas.

**A tabela de casos óbvios é o benchmark.** Um mentor do programa foi explícito: validar em escala exigiria simular a rede inteira; para a hackathon, cobrir os casos óbvios numa tabela é o equivalente de benchmark.

Estado real, medido no D3 (16/08):

```
caso                                    esperado      resultado
wallet fresca, histórico zero           suspicious    ✅ score 0
wallet fresca fundada por CEX, 2 dias   suspicious    ✅ score 60
wallet estabelecida fundada por CEX     trusted       ✅ score 857
endereço sancionado (OFAC)              gated         ✅ Lazarus Group, score 0
usa protocolos normais todo dia         trusted       ⏳ roadmap: sinal de contratos
fundada por wallet fresca suspeita      suspicious    ⏳ parcial: funding classifica
                                                         como unknown, não pune
```

Separação no conjunto de calibração: **10/10 fresh → suspicious, 10/10 established → trusted, com vão vazio de 109 pontos (84 a 193).** O estrato mid espalha 4 suspicious / 2 unknown / 4 trusted, que é o que um estrato de fronteira deve fazer.

## ⭐ A wallet fresca fundada por CEX: a melhor demonstração do desenho

```
funding 1.000 (exchange), maturity 0, volume 0  →  score 60  →  SUSPICIOUS
```

Com **soma linear** ela teria tirado cerca de 400 e passado. Com **média geométrica**, o eixo forte não compensou os fracos. Este é o argumento mais concreto para "por que não é só somar os sinais", e vale um trecho do pitch.

## ⚠️ Decisão sobre o vitalik.eth: TRUSTED está certo

A tabela original esperava que ele saísse suspicious ou unknown por ter 1 contraparte na janela. Ele saiu **TRUSTED com 563**, e a linha do benchmark é que estava errada, não o score.

Ele tem 1103 dias e 37 mil transações: é literalmente um dos endereços mais estabelecidos que existem.

E o "1 contraparte" era artefato de medição. A janela recente está tomada por spam **de entrada**. Isso revela um problema maior que a calibração não tinha nomeado:

> **Diversidade contando transações de entrada é manipulável.** Qualquer um pode spammar um endereço para alterar o número dele.

Ou seja: diversidade não saiu do score só por não separar os grupos. Saiu porque, do jeito que está medida, **mede a coisa errada**. Isso é uma resposta muito melhor no pitch, e não justifica reintroduzi-la com peso pequeno, o que seria calibrar no próprio alvo.

Se algum caso do benchmark não existir no conjunto, diga que é o próximo a cobrir. Não invente.

## e) A resposta pronta para a pergunta do juiz

> "O corte fica no vão entre os clusters do conjunto de referência. Os valores exatos saem de `npx tsx scripts/calibrate.ts`, que qualquer um roda em cima do `signals.csv` commitado."

## f) Honestidades a declarar de saída

```
n=30 é conjunto de referência, não estatística
diversidade e ritmo são janelados nas últimas ≤150 transações
mede histórico, não intenção
na v0.1 só um subconjunto dos pesos está ativo; o resto é roadmap declarado
```

Nenhuma delas enfraquece a v0.1 se você as disser primeiro.

## g) Fontes para funding provenance (se der tempo no D4-D5)

```
eth-labels (dawsbot)      GitHub, 169k+ endereços rotulados em chains EVM, importável
                          ❌ na prática é um scraper do Basescan, sem dataset
evm-labels (Earnifi)      GitHub, importável
⭐ Dune Spellbook          ADOTADO. Modelo cex_evms.addresses, commit pinado
                          9f61b0d de 28/01/2026: 4.957 endereços, 328 exchanges.
                          Reconstruível por scripts/build-cex-labels.ts, que
                          reproduz o arquivo byte a byte. Ver o bloco CEX em 4c2
                          para a medição e a ressalva de licença BSL 1.1.
⚠️ community-maintained: verificar antes de confiar

CEX hot wallets   conhecidas nos explorers (Blockscout já rotula várias)
Mixers            Tornado Cash, Houdini Swap. Reconhecer é heurístico:
                  "traversals de dinheiro muito estranhos". Na v0.1, uma lista
                  curta de endereços conhecidos basta para o compliance gate.
```

**Timebox: 2 blocos.** D2 inteiro, com transbordo máximo de 30 min no D3. Refinar limiar infinitamente é o padrão nº 1 do mapa de autossabotagem com outro nome.

---

# 6 · Riscos de execução

**1. Blockscout instável ou com rate limit no dia da demo. ⚠️ JÁ ACONTECEU.**
Em 15/08, por volta das 22h20, a Blockscout Pro devolveu 500 em **23 de 30 endereços** durante a coleta do D2, mesmo com os 3 retries. Sete dias antes da demo. O `--offline` do D7 não é rede de segurança teórica: é requisito, e não é cortável em hipótese nenhuma. Gravar um vídeo de backup no D8 para tocar caso tudo falhe ao vivo.

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
                       Trilha A da banca. Não depende de ninguém.

v0.2   próximo         camadas de sinal restantes: contratos rotulados,
                       rating humano (só quem usou pode votar), familiaridade
                       com o ecossistema x402. Depois, atestado em EIP-712
                       para que um CONTRATO consuma.

v0.3   depois          credencial ZK ligando o agente a um principal,
                       com escopo de autoridade
                       responde: "em nome de quem ele age?"
                       Trilha B da banca.

em paralelo            o teste do comerciante real, que segundo o RFP
                       é a pergunta que sustenta o negócio
```

Cobertura em relação ao RFP: a v0.1 já entrega duas das quatro wedges do KYA Stack (verificação do lado do comerciante, alimentada por reputação agente-a-agente). Credencial de agente e camada de disputa ficam nos marcos seguintes.
