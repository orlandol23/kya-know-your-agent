# Decisões

## Fonte de dados: Blockscout Pro, não Etherscan
A Etherscan V2 tirou a Base do tier gratuito. Blockscout Pro é compatível com
o formato Etherscan, então a troca custou uma variável de ambiente.

## A janela usa txlist, não o endpoint v2
O `/addresses/{addr}/transactions` devolveu 500 em 23 de 30 endereços durante
a coleta. O txlist paginado devolve os mesmos números, é ~10x mais rápido e
usa páginas numeradas, então as 3 vão em paralelo. Numa demo ao vivo isso é
a diferença entre 2s e 60s por verify.

## /counters precisa de duas leituras
O contador é computado preguiçosamente: a primeira chamada num endereço frio
devolve 0. Medi 51 de 74 endereços mudando na segunda leitura, um deles de
0 para 145.793. Contagem menor que a janela é impossível, então isso vira
prova de contador frio e dispara releitura.

## Diversidade e ritmo saíram do score
Medidos na calibração, não separam os grupos. Ritmo está invertido: wallet
nova de bot dispara 150 transações num dia, endereço antigo fica dormente.
Diversidade, do jeito que eu media, conta transações de ENTRADA, e qualquer
um pode spammar um endereço para mudar o número dele. Ou seja: não é só que
não separa, é que mede a coisa errada.

## O estrato não foi recomposto para melhorar os limiares
Escolher os endereços established pela diversidade garantiria que a
diversidade separasse. Isso é calibrar no próprio alvo.

## Média geométrica, não soma ponderada
Um eixo fraco não pode ser compensado por um forte. Caso concreto: wallet
fresca fundada por exchange tem funding 1.000, idade 0, volume 0. Com soma
teria tirado ~400 e passado. Com produto, tirou 60 e foi barrada.

## Compliance gate separado do score
Endereço sancionado não recebe nota baixa, recebe bloqueio. Score 0, gated.
É um portão, não uma nota. A lista vem da SDN do OFAC, publicação de 07/08/2026.

## Sem contrato verificador on-chain na v0.1
A assinatura EIP-191 já é verificável off-chain em 3 linhas. Contrato só cria
valor quando outro CONTRATO consome o atestado, e nesse dia o formato certo é
EIP-712. Fazer agora viraria retrabalho.

## Sem LLM em nenhum ponto
Determinístico é auditável e reproduzível. Um provedor pode conferir a conta.

## O gate roda antes do middleware de pagamento
Se rodasse depois, o agente rejeitado já teria pago. A ordem é o que sustenta
a frase "refused before settlement: paid nothing". O gate não confere a
assinatura sobre o campo `from` porque o middleware de pagamento a jusante
confere: um `from` forjado nunca liquida.

## O 403 devolve o atestado assinado inteiro
A recusa é ela própria verificável. O agente rejeitado pode conferir a
assinatura e ver por que foi barrado, sem precisar confiar na minha palavra.

## Blockscout fora do ar devolve 503, fail-closed
Se a fonte de dados cai, o vendedor não serve às cegas. A falha acontece
antes da liquidação, então ninguém paga por um veredito que não existe.

## unknown passa, só suspicious bloqueia
Três vereditos, não dois. Os casos claros têm decline automático; o meio
ambíguo é devolvido ao vendedor com o header X-KYA-Verdict, porque forçar uma
decisão binária num caso ambíguo é pior que não decidir.

## A UI não duplica nenhum limiar
Cortes, pesos e a linha "suspicious <= 84 < unknown < 193 <= trusted" vêm do
server via ?explain=1. Se o config.ts mudar, a tela acompanha. A interface é
descartável; a API não é.

## Fixtures são capturas datadas de endereços vivos
Os três endereços da demo continuam transacionando. A fixture congela o que a
demo mostra, e o arquivo carrega captured_at. Não é mock: é a resposta real
da API, guardada com data. O modo online roda contra a chain e está no repo.

## Sem fixture não há fallback silencioso
Endereço sem fixture no modo offline devolve 404, não uma resposta inventada.
Silêncio seria pior que erro.

## Os labels de CEX vêm do Dune Spellbook, em commit pinado
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

## O endereço established da demo foi trocado após auditoria de tags
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

## D17: o sinal de contraparte foi avaliado e adiado
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

## D18: checagem de fatos externos, 18/08/2026
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
deve ser dito. ⚠️ A frase que seguia aqui — "não existe perfil de comprador nem
endpoint público para consultar um" — é FALSA e está corrigida no D19.

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

## D19: correção ao D18 — o x402scan TEM página de comprador, 22/08/2026
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

## Custo de operação: o tier gratuito já cobre a v0.1
O tier Free da Blockscout Pro dá 100.000 créditos por DIA (confirmado na
página de planos em 18/08/2026), a 20 créditos por chamada e 5 requisições
por segundo. São 5.000 chamadas por dia; no pior caso de 7 chamadas por
verify, cerca de 700 verificações diárias, e o cache de 10 minutos estica
isso. O plano seguinte custa US$49 por mês e dá 100 milhões de créditos.

Consequência: o custo marginal por verificação é próximo de zero, e a fonte
de dados não é o gargalo econômico deste produto. O gargalo é adoção, não
infraestrutura.