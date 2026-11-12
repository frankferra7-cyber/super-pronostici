# SUPER PRONOSTICI — collegamento dati

## Fonte dati
L'app usa API Ninjas Football (Soccer) API. Il piano gratuito dichiara 3.000 chiamate al mese e copre calendario, risultati, classifiche, club e rose della stagione corrente. Il processo legge le sette competizioni configurate e scorre le pagine del calendario stagionale (50 partite per pagina).

- Serie A (`seriea`)
- Premier League (`epl`)
- La Liga (`laliga`)
- Bundesliga (`bundesliga`)
- Ligue 1 (`ligue1`)
- Champions League (`ucl`)
- Europa League (`uel`)

Documentazione: https://api-ninjas.com/api/football

## Attivazione della chiave (unico passaggio manuale)
1. Crea un account gratuito su https://api-ninjas.com/register
2. Apri la dashboard API Ninjas e copia la tua API key.
3. Nel repository GitHub apri Settings → Secrets and variables → Actions → New repository secret.
4. Nome: `API_NINJAS_KEY`; valore: la chiave copiata.
5. Apri Actions → Refresh football data → Run workflow.

La chiave viene usata solo da GitHub Actions e non viene inserita nel sito pubblico. Il vecchio secret `API_FOOTBALL_KEY` non è più utilizzato.

## Modello attuale
Le stime 1X2, doppia chance, Over/Under 2.5 e Goal/No Goal usano una distribuzione di Poisson basata sulle medie recenti casa/trasferta (ultimi 75 giorni disponibili). Se il campione non è sufficiente, la partita viene mostrata senza pronostico.

## Limiti dichiarati
I mercati giocatore (ammonizioni e tiri in porta) non vengono mostrati come pronostici finché non sono disponibili dati individuali sufficienti e verificabili. Il punteggio esatto è soltanto il risultato più probabile del modello, non una previsione certa. Le probabilità sono stime, non garanzie.

## Aggiornamento
Il workflow aggiorna i dati ogni giorno alle 06:15 UTC, oppure manualmente dalla scheda Actions. Il calendario copre le partite future disponibili nell'intera stagione corrente, non solo i prossimi dieci giorni.
