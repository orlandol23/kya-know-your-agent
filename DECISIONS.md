# Decisions (Decisões)

> **Note for English readers.** The body of this file is in Portuguese: it was
> written as a working record while the system was being built, not as a
> deliverable. Every section is one decision and the reasoning behind it, and
> the headings carry an English translation so the file can be navigated. The
> same material in English is in [`README.md`](README.md),
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and
> [`docs/POSITIONING.md`](docs/POSITIONING.md).

## Data source: Blockscout Pro, not Etherscan (Fonte de dados: Blockscout Pro, não Etherscan)
A Etherscan V2 tirou a Base do tier gratuito. Blockscout Pro é compatível com
o formato Etherscan, então a troca custou uma variável de ambiente.

## The window uses txlist, not the v2 endpoint (A janela usa txlist, não o endpoint v2)
O `/addresses/{addr}/transactions` devolveu 500 em 23 de 30 endereços durante
a coleta. O txlist paginado devolve os mesmos números, é ~10x mais rápido e
usa páginas numeradas, então as 3 vão em paralelo. Numa demo ao vivo isso é
a diferença entre 2s e 60s por verify.

## /counters needs two reads (/counters precisa de duas leituras)
O contador é computado preguiçosamente: a primeira chamada num endereço frio
devolve 0. Medi 51 de 74 endereços mudando na segunda leitura, um deles de
0 para 145.793. Contagem menor que a janela é impossível, então isso vira
prova de contador frio e dispara releitura.

## Diversity and cadence left the score (Diversidade e ritmo saíram do score)
Medidos na calibração, não separam os grupos. Ritmo está invertido: wallet
nova de bot dispara 150 transações num dia, endereço antigo fica dormente.
Diversidade, do jeito que eu media, conta transações de ENTRADA, e qualquer
um pode spammar um endereço para mudar o número dele. Ou seja: não é só que
não separa, é que mede a coisa errada.

## The stratum was not recomposed to improve the thresholds (O estrato não foi recomposto para melhorar os limiares)
Escolher os endereços established pela diversidade garantiria que a
diversidade separasse. Isso é calibrar no próprio alvo.

## Geometric mean, not a weighted sum (Média geométrica, não soma ponderada)
Um eixo fraco não pode ser compensado por um forte. Caso concreto: wallet
fresca fundada por exchange tem funding 1.000, idade 0, volume 0. Com soma
teria tirado ~400 e passado. Com produto, tirou 60 e foi barrada.

## Compliance gate separate from the score (Compliance gate separado do score)
Endereço sancionado não recebe nota baixa, recebe bloqueio. Score 0, gated.
É um portão, não uma nota. A lista vem da SDN do OFAC, publicação de 07/08/2026.

## No on-chain verifier contract in v0.1 (Sem contrato verificador on-chain na v0.1)
A assinatura EIP-191 já é verificável off-chain em 3 linhas. Contrato só cria
valor quando outro CONTRATO consome o atestado, e nesse dia o formato certo é
EIP-712. Fazer agora viraria retrabalho.

## No LLM at any point (Sem LLM em nenhum ponto)
Determinístico é auditável e reproduzível. Um provedor pode conferir a conta.

## The gate runs before the payment middleware (O gate roda antes do middleware de pagamento)
Se rodasse depois, o agente rejeitado já teria pago. A ordem é o que sustenta
a frase "refused before settlement: paid nothing". O gate não confere a
assinatura sobre o campo `from` porque o middleware de pagamento a jusante
confere: um `from` forjado nunca liquida.

## The 403 returns the whole signed attestation (O 403 devolve o atestado assinado inteiro)
A recusa é ela própria verificável. O agente rejeitado pode conferir a
assinatura e ver por que foi barrado, sem precisar confiar na minha palavra.

## Blockscout down: the GATE answers 503, fail-closed (Blockscout fora do ar: o GATE devolve 503, fail-closed)
Se a fonte de dados cai, o vendedor não serve às cegas. A falha acontece
antes da liquidação, então ninguém paga por um veredito que não existe.
Isso vale para o gate, e só para ele. O servidor público de /verify não
fail-closed: degrada para fixture rotulada, ou devolve 502 quando não há
fixture para o endereço. A assimetria é deliberada e está na última entrada.

## unknown passes, only suspicious blocks (unknown passa, só suspicious bloqueia)
Três vereditos, não dois. Os casos claros têm decline automático; o meio
ambíguo é devolvido ao vendedor com o header X-KYA-Verdict, porque forçar uma
decisão binária num caso ambíguo é pior que não decidir.

## The UI duplicates no threshold (A UI não duplica nenhum limiar)
Cortes, pesos e a linha "suspicious <= 84 < unknown < 193 <= trusted" vêm do
server via ?explain=1. Se o config.ts mudar, a tela acompanha. A interface é
descartável; a API não é.

## Fixtures are dated captures of live addresses (Fixtures são capturas datadas de endereços vivos)
Os três endereços da demo continuam transacionando. A fixture congela o que a
demo mostra, e o arquivo carrega captured_at. Não é mock: é a resposta real
da API, guardada com data. O modo online roda contra a chain e está no repo.

## Nothing stale is served unlabelled (Nada velho é servido sem rótulo)
O modo offline resolve em três passos: a fixture commitada, depois
data/cache/<endereço>.json EM QUALQUER IDADE, e só então 404 (503 no gate).
A garantia não é que dado velho nunca é servido (o passo dois serve uma captura
de qualquer idade em vez de falhar) e sim que ele nunca é servido SEM RÓTULO:
o X-KYA-Source nomeia a fonte que respondeu e evidence.fetched_at carrega o
instante em que a chain foi lida. Resposta inventada, essa não existe em passo
nenhum: sem fixture e sem cache é erro, não silêncio.

## The CEX labels come from Dune Spellbook, at a pinned commit (Os labels de CEX vêm do Dune Spellbook, em commit pinado)
A heurística de exchange (EOA com mais de 1M de transações na Base que financiou
pelo menos 3 das 74 wallets amostradas) sempre teve o mesmo buraco: ela mede
escala custodial, não identidade. Agora existe fonte. O modelo `cex_evms.addresses`
do Dune Spellbook, no commit `9f61b0d` de 28/01/2026, com 4.957 endereços e 328
exchanges, está commitado em `data/cex-addresses-evm.json`. O bloco `meta` do
arquivo carrega commit, URL raw, sha256 do SQL de origem, licença e data, e
`scripts/build-cex-labels.ts` reconstrói o arquivo byte a byte a partir do commit
pinado. Reprodutível, não confiado na minha palavra.

O `lookupCex` roda ANTES da heurística e devolve identity `confirmed`; o miss cai
na heurística de sempre, com identity `inferred`. A CLASSE é `exchange` nos dois
caminhos. Isso é deliberado: o score lê `class` e nada mais, então a fonte melhora
o que o KYA pode AFIRMAR sobre um financiador, nunca o quanto ele conta.

O que a medição realmente deu, sobre os 30 endereços de `addresses.csv`:

  - 4 de 30 endereços dão hit, e os quatro pelo MESMO financiador,
    `0x3304e22ddaa22bcdc5fca2269b418046ae7b566a` = Binance 76. São
    0xBEabA203, 0x0B53cc25, 0xeA258496 e 0x2CfF890f.
  - São 24 financiadores distintos no conjunto. Exatamente 1 está na lista.
  - Das 3 wallets que a heurística classificava como exchange, 2 foram
    confirmadas pelo Dune: Binance 76 e Bybit 6. A terceira, `0x8581784d`,
    não está em nenhuma lista que eu tenha achado e continua `inferred`.
    Ela não foi refutada, só não foi nomeada.
  - 0 classes mudaram e 0 scores mudaram nos 30. Verificado ponta a ponta
    contra a coluna `funding_class` de `data/signals.csv`, que é a saída do
    código antigo, commitada antes da lista existir.

Isso é cobertura estreita e não deve ser citado como outra coisa. 1 financiador
em 24 não amplia o alcance do sinal: confirma a identidade de uma wallet que já
importava para a demo, e substitui uma inferência comportamental por um nome com
fonte citável. O ganho é de qualidade da afirmação, não de recall.

Ressalva de licença: os dados são Business Source License 1.1, licenciante Dune
Analytics AS, Change Date 2027-03-03, quando viram GPLv3+. Serve para demo e
avaliação. Ler a licença antes de qualquer uso em produção.

Ressalva de fonte: a lista é curada pela comunidade e está congelada em janeiro
de 2026. É a melhor fonte disponível, não um oráculo: pode estar desatualizada e
pode estar errada. E um hit prova a identidade do ENDEREÇO, não que o pagador
seja dono da conta na exchange. Qualquer um pode receber uma transferência não
solicitada.

## The demo's established address was swapped after a tag audit (O endereço established da demo foi trocado após auditoria de tags)
O `0x2CfF890f0378a11913B6129B2E97417a2c302680` saiu da demo. Auditoria de
terceiros na Blockscout: tags `Fake_Phishing3515158` e `NEAR Intents: Treasury`,
risk score 75.5 do DD.xyz, com flags de FLAGGED ADDRESS e WASH TRADER. Mostrar
TRUSTED 857 nesse endereço ao vivo seria indefensável.

O substituto é `0xeA258496a9311Ffe29CDf920Ca0E8BB4B41c9F04`: sem tags, risk score
21.2 sem alerta, 51.666 transações, 663 dias. O motivo principal não é nenhum
desses: é que ele é financiado pelo MESMO Binance 76 que financia o endereço
fresh da demo. O argumento da demo depende disso. Mesmo funder confirmado, mesma
classe de funding, e mesmo assim TRUSTED 857 contra SUSPICIOUS 60. A diferença
está inteira em idade e volume, que é exatamente o que o score deveria medir.

O `0x2CfF` PERMANECE em `data/addresses.csv` e `data/signals.csv`. A calibração é
sobre comportamento observável, não sobre reputação externa, e tirar um endereço
do conjunto de referência porque uma fonte de terceiros não gostou dele seria
selecionar a amostra pelo resultado. É o mesmo erro que a decisão sobre não
recompor o estrato já recusa. Os limiares continuam calibrados sobre os 30.

A ressalva honesta: o KYA continuaria dando 857 no `0x2CfF` hoje. A troca muda o
que a demo MOSTRA, não o que o score diz. O score lê histórico on-chain, e
histórico on-chain não vê tag de phishing nem risk score de terceiros. Isso é um
limite real da v0.1, não um detalhe de apresentação, e a lista de sanções do OFAC
é o único sinal de reputação externa que o gate consome hoje.

## D17: the counterparty signal was evaluated and deferred (o sinal de contraparte foi avaliado e adiado)
A ideia era um quarto eixo: com quantas contrapartes distintas o endereço
interagiu, medido contra a popularidade real dos contratos na chain. A fonte
candidata era `/stats/hot-smart-contracts` da Blockscout Pro. Medido em 17/08:
devolveu 524 (timeout de origem) na janela de 30 dias e timeout de cliente na de
1 dia. A Blockscout não expõe nenhuma métrica de distinct-callers.

Sem fonte que responda, o eixo só poderia ser preenchido com a diversidade que já
foi medida e descartada na calibração, que conta transações de ENTRADA e que
qualquer um pode inflar spammando o endereço. Seria um número na tela sem nada
por trás.

Três eixos com fonte citada valem mais que quatro com um mal medido. Adiado, não
descartado: volta quando existir uma fonte que responda.

## D18: external fact-check, 18/08/2026 (checagem de fatos externos)
O pitch foi para checagem de fatos e três afirmações sobre o mundo externo
estavam erradas ou imprecisas. Nada aqui toca medição minha: limiares, scores,
calibração, os 30 endereços e as fixtures seguem como estavam. O que muda é o
que o repositório AFIRMA sobre coisas que não são minhas.

**Os números do x402 são janela, não cumulativo.** Os "7M+ transactions" que o
README citava vêm do x402scan e são uma JANELA MÓVEL DE 30 DIAS. O cumulativo do
protocolo passa de 100 milhões de transações (Chainalysis, Coinbase,
agenteconomy.to), com ticket médio sub-dólar. Toda menção precisa rotular a
janela: citar 7M como total do protocolo subestima o mercado em mais de uma
ordem de grandeza, e citar sem rótulo é impreciso nos dois sentidos.

**x402 não é mais "o protocolo da Coinbase".** Em 14/07/2026 a Linux Foundation
anunciou o lançamento operacional da x402 Foundation, com a Coinbase
contribuindo o protocolo por completo. São 40 organizações, incluindo Visa,
Mastercard, Stripe, Google, AWS, American Express, Circle, Cloudflare e Shopify.
Chamar de protocolo da Coinbase numa banca é datado, e desperdiça o argumento:
governança neutra com esse conjunto de participantes é sinal de que o problema
do comprador vale a pena resolver.

**O x402scan não é o explorador oficial do x402.** É da Merit Systems, open
source. É o explorador principal do ecossistema, não o oficial, e é assim que
deve ser dito. ⚠️ A frase que seguia aqui, "não existe perfil de comprador nem
endpoint público para consultar um", é FALSA e está corrigida no D19.

**Denylist de mixer é escolha de política, não exigência do OFAC.** O Tornado
Cash saiu da lista SDN em março de 2025. Tratar "OFAC SDN e mixers conhecidos"
como uma categoria só de obrigação é errado: a SDN é exigência legal, a denylist
de mixer é escolha de política deste projeto. O código já trata as duas como
listas separadas; era só o texto que conflava.

**Existe reputação por histórico no x402 além do KYA.** AgentQuay, DJD
AgentScore, ACHIVX, AgentKarma e Agent402. Todos pontuam HISTÓRICO DE PAGAMENTO
X402, e isso significa cold start para carteira antiga que nunca usou x402: para
eles, um endereço com 663 dias e 51.666 transações na Base começa do zero se o
x402 for novidade para ele. O KYA pontua histórico geral da Base. Essa é a
diferença, e não é afirmação de superioridade: é escolha de fonte, com o custo
simétrico de não medir nada específico de x402.

**O Reputation Registry do ERC-8004, medido como implantado, não está saudável.**
Um preprint de 2026 mediu o registry em produção: o feedback raramente está
ancorado numa interação verificável, e mais de 90% dos revisores na Base
apresentam comportamento sybil coordenado. É PREPRINT, e fica registrado como
tal: não é revisado por pares e não deve ser citado como se fosse. Se sustentar,
é o argumento mais forte a favor de reputação derivada de histórico on-chain em
vez de reputação declarada por pares.

## D19: correction to D18, x402scan DOES have a buyer page, 22/08/2026 (correção ao D18: o x402scan TEM página de comprador)
A afirmação de que o x402scan não tem perfil de comprador, repetida no README,
no PLAN.md e no próprio D18, é FALSA. A rota `/buyer/<address>` existe desde
março de 2026, responde 200, e está no código-fonte aberto do x402scan.

A formulação correta, que é a que está agora no README:

> x402scan has a per-address buyer page (`/buyer/<address>`, since March 2026)
> showing that address's x402 payment history. It has no public API for it, and
> it says nothing about a wallet's general Base history, which is the question
> KYA answers.

O argumento do KYA não dependia da frase errada, e fica mais preciso sem ela. O
que o x402scan mostra é o histórico de PAGAMENTO x402 daquele endereço, por uma
tela, sem API. O que o KYA lê é o histórico GERAL da Base, por uma API pública, e
assina o resultado. São perguntas diferentes, e a diferença é exatamente o cold
start: uma carteira com dois anos de Base e nenhum pagamento x402 tem página de
comprador vazia. Para qualquer coisa que leia histórico x402 ela começa do zero;
para o KYA ela é track record. O mesmo vale para os scorers de x402 listados no
D18, e é o mesmo argumento, agora sem uma negativa falsa para sustentá-lo.

Como o erro passou: a checagem do D18 confirmou o que o x402scan É (explorador da
Merit Systems, não oficial) e não testou a afirmação sobre o que ele NÃO tem.
Verificar a existência de uma rota é um curl. A lição é que negativa sobre
produto de terceiro precisa da mesma verificação que uma positiva, e é mais
perigosa, porque é a que costuma virar argumento de venda.

## Operating cost: the free tier already covers v0.1 (Custo de operação: o tier gratuito já cobre a v0.1)
O tier Free da Blockscout Pro dá 100.000 créditos por DIA (confirmado na
página de planos em 18/08/2026), a 20 créditos por chamada e 5 requisições
por segundo. São 5.000 chamadas por dia; no pior caso de 7 chamadas por
verify, cerca de 700 verificações diárias, e o cache de 10 minutos estica
isso. O plano seguinte custa US$49 por mês e dá 100 milhões de créditos.

Consequência: o custo marginal por verificação é próximo de zero, e a fonte
de dados não é o gargalo econômico deste produto. O gargalo é adoção, não
infraestrutura.


## The public deployment: daily budget, labelled degradation, separate attester (O deploy público: orçamento diário, degradação rotulada, attester separado)
A v0.1 subiu numa URL pública porque a banca pediu. Uma URL pública muda o modelo
de ameaça: /verify não tem autenticação, nada a montante limita quem pergunta, e
cada verify ao vivo gasta 6 chamadas (7 com contador frio) de uma cota medida. O
cache de 10 minutos só ajuda em repetição, então um chamador variando o endereço
esgota os 100.000 créditos diários em cerca de 20 minutos, com um curl em laço.

**Orçamento diário de verifies ao vivo.** Contador em processo, reset na virada
do dia UTC, cap em KYA_DAILY_VERIFY_BUDGET (default 500). Só leitura que chega na
Blockscout é cobrada: cache hit sai de graça, que é exatamente o tráfego dos
endereços da demo sendo clicados. É orçamento, não cerca: requisições concorrentes
podem passar pela checagem antes de qualquer uma cobrar, e o excesso fica limitado
pelo número de requisições em voo. É por instância: duas réplicas têm dois
orçamentos, que é o preço de manter o serviço sem estado compartilhado.

**Degradar para fixture em vez de 502.** Estourado o orçamento, ou caída a
Blockscout, o servidor devolve a captura commitada em vez de falhar. Uma URL de
avaliação que responde 502 sob abuso não serve para nada, e a alternativa honesta
já existia: fixture é captura datada de endereço vivo, não mock. Sem fixture para
o endereço, os dois motivos se separam. Orçamento estourado é este serviço
limitando o chamador: 429, com Retry-After até 00:00 UTC. Blockscout fora do ar é
falha de upstream: 502, com a mensagem real do upstream, não com a do fixture que
faltou. Dizer 429 a quem fez uma requisição só seria mentira.

**Por que o /verify degrada e o gate NÃO.** O /verify é leitura e não liquida
nada: responder com uma captura datada, rotulada como tal, é mais útil que um 502
e não custa nada a quem consome. O gate decide se um agente PAGANTE vai ser
servido; servir com evidência velha ali é o erro que o produto inteiro existe
para evitar. Então gate.ts continua fail-closed em 503 e não ganhou nenhuma
degradação. A assimetria é a linha entre informar e decidir.

**Os dois headers.** X-KYA-Source (live | cache | fixture) diz qual fonte
respondeu. X-KYA-Degraded (budget | upstream) diz por que uma réplica entrou no
lugar de uma leitura ao vivo. Sem eles a degradação seria silenciosa, que é
exatamente o que a entrada "nada velho é servido sem rótulo" recusa. E
evidence.fetched_at continua carregando o instante da captura, então um replay
não se passa por leitura fresca nem para quem ignorar os dois headers.

**O attester de produção é uma chave separada.** A chave que assina em produção
não é a do .env local que aparece nos exemplos do README. O endereço dela está
publicado no README, fora de banda, porque "verificável sem confiar nesta API" só
significa alguma coisa se a API não for quem diz em quem confiar. A consequência
é que uma resposta ao vivo traz um attester diferente do dos exemplos, e o README
avisa disso em vez de deixar quem comparar achar que encontrou uma inconsistência.


## Per-IP limit on /verify (Limite por IP no /verify)
A entrada anterior já é honesta sobre o orçamento diário: "é orçamento, não
cerca". Ele conta verifies ao vivo por processo, sem noção nenhuma de quem
está perguntando. Isso é suficiente para o serviço não estourar a cota da
Blockscout, mas não impede que UM chamador seja quem gasta essa cota por
todo mundo: variando o endereço, ele esgota os 500 verifies do dia em cerca
de vinte minutos, e dali em diante toda visita clicando num dos quatro
endereços da demo cai em fixture sem nenhum motivo além de outra pessoa ter
feito um laço de curl mais cedo. Um orçamento por processo não vira cerca só
porque alguém adiciona mais checagem em cima dele; falta o eixo que ele nunca
teve, que é "quem".

**Por que 30/min.** O limite é por IP de origem, janela fixa de um minuto,
default `KYA_VERIFY_RATE_LIMIT_PER_MIN=30`. Não é medido como os cutoffs do
score; é escolhido, como os pesos e a penalidade de burst. Trinta é folgado
para o uso real da demo (alguém clicando nos quatro endereços na UI fica
muito abaixo disso) e ainda assim baixo o suficiente para que um chamador em
laço não consiga mais varrer o orçamento do dia em vinte minutos sozinho: ele
teria que dividir a varredura por IPs diferentes, o que já é um obstáculo
bem maior que nenhum. Lido do ambiente a cada checagem, igual
`dailyVerifyBudget()`, então dá para retunar pelo painel do Railway sem
redeploy. `KYA_VERIFY_RATE_LIMIT_PER_MIN=0` é a mesma convenção do
orçamento diário: zero é "sem limite por IP", não "bloqueia tudo".

O limite roda ANTES da checagem de orçamento em `handleVerify`. Uma
requisição que ele recusa nunca chega a `liveBudgetRemaining()`, então ser
generoso demais aqui não tem custo nenhum sobre o orçamento que um chamador
bem-comportado depende: o pior caso é responder 429 cedo demais, nunca
cobrar um verify que não deveria.

**Por que o gate continua intocado.** A mesma assimetria da entrada anterior
vale aqui: `/verify` é leitura pública, sem autenticação, e é exatamente por
isso que precisa de uma defesa por chamador. `src/gate.ts` roda dentro do
processo de um vendedor, contra a própria chave dele, decidindo se um agente
PAGANTE é servido: não é a superfície pública que este limite protege, e
colocar rate limit ali resolveria um problema que o gate não tem enquanto
inventa um novo (um vendedor legítimo com tráfego de pico sendo barrado pelo
próprio serviço de reputação). Fica de fora pelo mesmo motivo que o
orçamento diário ficou de fora dele.

**`trust proxy` = 1 hop é uma suposição do Railway.** O limite conta por
`req.ip`, e o Express só lê `X-Forwarded-For` como confiável se mandarmos.
`app.set('trust proxy', 1)` diz para confiar exatamente NO PRIMEIRO hop
desse cabeçalho, que no deploy atual é o proxy do Railway na frente do
processo, de onde vem o IP real de quem chamou. Sem isso, toda requisição
pareceria vir do proxy, o limite juntaria todo mundo num balde só, e os
primeiros 30 chamados por minuto de QUALQUER pessoa trancariam todo o
resto. Confiar em UM hop, não em "todos" (`trust proxy: true`), importa na
outra direção também: um cabeçalho forjado com hops extras não muda qual
entrada o Express lê como IP do cliente. Se o serviço um dia ganhar outra
camada de proxy na frente (um CDN, por exemplo), esse número precisa
acompanhar, ou volta a errar o IP que conta.

## OFAC list: automated refresh, local lookup (Lista OFAC: refresh automatizado, consulta local)
**Registrado como plano, ainda não construído.**

Hoje `src/sanctions.ts` é um `Map` escrito à mão com 100 endereços, extraídos do
SDN.XML publicado em 07/08/2026 e capturados em 16/08. A proveniência mora num
comentário e o "refresh before any real deployment" é uma frase, não um
mecanismo. Uma lista de sanções que envelhece em silêncio é o pior tipo de
lista: continua respondendo com confiança total sobre um mundo que mudou. E
remoção pesa tanto quanto adição, porque endereço deslistado que segue
bloqueado é pagador legítimo recusado.

A saída óbvia seria consultar a OFAC em tempo de requisição. É a errada, por
quatro motivos.

**Fail-closed viraria dependência de uptime alheio.** A entrada "Blockscout fora
do ar: o GATE devolve 503" já aceita uma dependência de rede, mas aquela é
inevitável: dado por endereço não dá para snapshotar. Uma lista dá. Adicionar
uma dependência evitável ao mesmo caminho fail-closed significa que uma
indisponibilidade do Tesouro americano derruba o faturamento de todo vendedor
rodando o gate. O gate não tem o direito de importar essa falha.

**O modo offline morre.** É o caminho que o CI e os 6 testes usam: sem chave,
sem rede, fixtures commitadas. Consulta ao vivo no meio da classificação de
financiador quebra exatamente a propriedade que torna este repositório
verificável por quem clona.

**Decisão de compliance precisa ser reconstituível.** "Por que este pagador foi
bloqueado no dia 3?" tem que ser respondível por commit. Com fetch ao vivo não
é: não sobra registro do que a lista dizia naquele instante.

**O SDN.XML é grande.** Ninguém parseia aquilo por requisição, então na prática
existiria cache com TTL. Cache com TTL é snapshot com auditoria pior.

**O que fazer no lugar: o padrão que este repo já usou.** Os labels de CEX
resolveram este mesmo problema uma vez, e melhor: `data/cex-addresses-evm.json`
com bloco `meta` (commit, URL raw, sha256 da fonte, licença, data) e
`scripts/build-cex-labels.ts` reconstruindo o arquivo byte a byte. Comparada a
ela, a lista OFAC é hoje o dataset mais fraco dos dois. A correção é nivelar
por cima:

1. `data/ofac-sdn-eth.json` com bloco `meta`: URL da fonte, data de publicação
   da lista, data de extração, sha256 do XML baixado, contagem de endereços.
2. `scripts/build-ofac-list.ts` filtrando `idType == "Digital Currency Address
   - ETH"`, determinístico, mesma forma do builder de CEX.
3. `src/sanctions.ts` vira loader fino sobre o JSON. A API pública
   (`OFAC_SANCTIONED`, `sanctionEntryFor`) não muda, então `funding.ts` não é
   tocado e o teste de classificação continua valendo.
4. Workflow agendado rodando o builder e abrindo PR quando o conteúdo muda. O
   diff do PR é a auditoria: mostra adição E remoção, revisadas por uma pessoa
   antes de virarem comportamento.
5. Idade rotulada, seguindo "nada velho é servido sem rótulo": a data de
   publicação entra na evidência do atestado, e o servidor avisa no boot quando
   a lista passa de N dias.

Resumindo a escolha: refresh dinâmico, consulta local. O que está hardcoded não
é a consulta, é o processo de atualização, e é ele que sai daqui.

## Pending and frozen until the jury's complete feedback arrives (Pendente e congelado até o feedback completo da banca, 2026-09-07)
Em 06/09/2026 o dono congelou toda alteração neste repositório até receber o
feedback completo da banca do Hackathon Web3 Global #02. Esta seção registra o
que estava na fila para que nada se perca na espera. **Nada disto foi
executado.** Cada item vira uma entrada própria nesta lista quando for feito.

1. **O fix de segurança apontado pela banca**: o gate gasta crédito do
   Blockscout com pagamento que ninguém assinou. Diagnóstico, escopo aprovado
   (Opção A: `paymentMiddleware` primeiro, `kyaGate()` escopado na rota paga),
   escopo recusado e checkpoints estão em
   [`docs/SECURITY-FIX-BRIEFING.md`](docs/SECURITY-FIX-BRIEFING.md), com o
   plano detalhado em [`docs/SECURITY-FIX-PLAN.md`](docs/SECURITY-FIX-PLAN.md)
   e o mapa de código em [`docs/CODE-REFERENCE.md`](docs/CODE-REFERENCE.md).
   O item 1 do briefing já está respondido: a produção sobe `src/server.ts`
   (`package.json`, script `start`), então a exposição real é a demo e o
   desenho da lib. Dívida de desenho, não incêndio.
2. **`expires_at` dentro do corpo assinado** e uma seção "What this
   attestation does NOT prove" no README. Achado alto da auditoria de
   setembro ([`docs/AUDIT-2026-09.md`](docs/AUDIT-2026-09.md)): o snippet de
   verificação confere só o assinante, então aceita atestado de meses atrás.
3. **`source` (`live | cache | fixture`) dentro do corpo assinado**, não só no
   header `X-KYA-Source`. Decidido em 06/09: quem repassa o atestado tem que
   repassar o rótulo junto. Enum de três valores, custo zero. Vai no mesmo
   commit que o item 2, porque mexe na mesma superfície.
4. **Snippet Python do README com `ensure_ascii=False`**: sem isso a
   verificação quebra no primeiro nome da lista SDN com diacrítico, porque
   `funding.label` e `reasons[0]` estão no corpo assinado. Teste com rótulo
   não-ASCII junto.
5. **`kyaGate()` valida a configuração na montagem** (chamar
   `attesterAccount()` ao construir o middleware), e `docs/ARCHITECTURE.md`
   passa a dizer o que o código faz.
6. **Testes dos caminhos críticos** que hoje não têm nenhum: 503 fail-closed
   do gate, orçamento diário, 400 antes de qualquer I/O, 404 sem fixture.
7. **A bifurcação da demo** (briefing, §10): recomendada a opção (b), declarar
   em vez de mudar. O default continua simulado, a saída imprime que o
   facilitator stub aceita qualquer assinatura, e o README documenta a linha do
   modo `--real`. Decidir depois do fix, não antes.
8. **Refresh automatizado da lista OFAC**: já decidido acima ("OFAC list:
   automated refresh, local lookup"); só a execução espera.

Ordem recomendada quando descongelar: item 1 seguindo o §11 do briefing (um
commit); itens 2 e 3 juntos (um commit, a mesma superfície); item 4; item 15
(commit próprio, barato); itens 5 e 6 com os itens 13 e 14, os quatro a mesma
superfície de execução: configuração na montagem, testes dos caminhos
críticos, lint no CI e o teste de ponta a ponta do x402; item 7; item 8;
passada final pela checklist "Medium and low, apply-only" de
[`docs/AUDIT-2026-09.md`](docs/AUDIT-2026-09.md), que é o registro canônico
desses itens; itens 9 a 12 por último, porque são estruturais e nenhum é
urgente. Cada um com o teste vermelho antes e verde depois, como o resto deste
repositório, e cada um no seu próprio PR: uma caixa desta fila fecha no PR
que fecha o item, com o link.

Segunda passada, 07/09/2026, além da auditoria (itens 9 a 12, também congelados):

9. **Versão do esquema no atestado.** Um `schema_version` dentro do corpo
   assinado, para que consumidores evoluam sem quebrar a verificação. Casa
   com a ida para EIP-712 (typed data) que já está no roadmap: decidir os dois
   juntos.
10. **Rotação da chave do attester.** O endereço de produção é pinado
    out-of-band de propósito, e isso é o certo. Falta o procedimento de
    rotação: janela de sobreposição em que as duas chaves são válidas, onde o
    novo endereço é publicado, e por quanto tempo um atestado da chave antiga
    continua aceitável. Sem isso, uma rotação forçada quebra todo consumidor de
    uma vez.
11. **Frescor dos rótulos de CEX.** Os labels vêm do Dune Spellbook em commit
    pinado, e um rótulo velho vira um "funded by Binance" errado num atestado
    assinado. É a mesma decisão que a lista OFAC já teve: cadência de refresh
    e idade rotulada na evidência.
12. **Higiene compartilhada pelos seis repositórios.** Dependabot (npm e
    github-actions), `SECURITY.md` apontando para o private vulnerability
    reporting do GitHub (sem e-mail pessoal no arquivo), proteção da branch
    default exigindo o CI verde.

Terceira passada, 09/09/2026, do review escrito da banca e do re-audit de
dependências (itens 13 a 15, também congelados):

13. **Lint e formatter como gate de CI.** O review escrito da banca apontou
    "sem lint/formatter claramente configurados como gate reprodutível", e
    nenhum documento da fila cobria. Um linter com config flat (oxlint ou
    eslint, a decidir na execução; o critério é rodar em Node 22 sem passo de
    build), mais uma linha no `ci.yml` junto do typecheck e da suíte offline.
14. **Teste de ponta a ponta do x402: assinatura real, liquidação observada.**
    O review da banca registrou que não existe teste de assinatura x402
    seguido de liquidação, e que o teste de ordem usa um contador no lugar do
    middleware de pagamento. O contador não é o erro: ele existe para provar a
    ordem (kya.test.ts, teste 5). O que falta é o outro extremo: assinar uma
    autorização EIP-3009 com `viem`, deixar o `x402-express` de verdade
    verificar, e observar a liquidação contra o facilitator do próprio
    processo. Entra junto do item 6.
15. **`npm audit fix` não quebrante para o axios.** `npm audit --omit=dev`
    reexecutado em 09/09: axios 1.0.0 a 1.17.0 em 2 advisories high, alcançados
    pelo `@coinbase/cdp-sdk`, dependência do `x402-express`. Os advisories são
    posteriores à auditoria de 05/09, que registrara zero no server. O fix é
    `npm audit fix` simples, sem quebrar nada: commit próprio, com a suíte
    offline verde depois. Os 30 moderate (cadeia x402, wagmi, walletconnect)
    só saem com downgrade quebrante do `x402-express` a 0.4.1: não fazer; o
    Dependabot do item 12 resolve pelo upstream.
