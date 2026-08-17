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
21.2 sem alerta, 49.577 transações, 659 dias. O motivo principal não é nenhum
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