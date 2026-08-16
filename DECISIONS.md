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