# SUPER PRONOSTICI — collegamento dati

## Fonte dati
L'app usa API-Football (API-SPORTS). Il piano gratuito pubblica 100 richieste al giorno; il processo pianificato esegue due aggiornamenti giornalieri e legge calendario e risultati recenti delle sette competizioni configurate.

- Serie A (135)
- Premier League (39)
- La Liga (140)
- Bundesliga (78)
- Ligue 1 (61)
- Champions League (2)
- Europa League (3)

## Attivazione della chiave (unico passaggio manuale)
1. Crea un account gratuito su https://dashboard.api-football.com/register
2. Nel pannello API-Football apri Account → My Access e copia la API key.
3. Nel repository GitHub apri Settings → Secrets and variables → Actions → New repository secret.
4. Nome: `API_FOOTBALL_KEY`; valore: la chiave copiata.
5. Apri Actions → Refresh football data → Run workflow.

La chiave viene usata solo da GitHub Actions e non viene inserita nel sito pubblico.

## Modello attuale
Le stime 1X2, doppia chance, Over/Under 2.5 e Goal/No Goal usano una distribuzione di Poisson basata sulle medie recenti casa/trasferta. Se il campione non è sufficiente, il pronostico non viene prodotto.

## Limiti dichiarati
I mercati giocatore (ammonizioni e tiri in porta) non vengono mostrati come pronostici finché non sono disponibili dati individuali sufficienti e verificabili. Il punteggio esatto non viene inventato. Le probabilità sono stime, non garanzie.

## Aggiornamento
Il workflow aggiorna i dati ogni giorno alle 06:15 e 18:15 UTC, oppure manualmente dalla scheda Actions.
