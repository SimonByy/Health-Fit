# Health Hub

Persoonlijke health- en fitnessapp: één overzicht van **Apple Health** (inclusief Garmin-data die daarheen synct), **voeding** (via Apple Health) en **Hevy** (krachttraining), met een **AI-assistent** die vragen beantwoordt op basis van je eigen data.

Installeerbaar op je iPhone als app (PWA), zonder App Store.

## Architectuur

```
iPhone: Health Auto Export ──(elk uur, JSON)──► Supabase Edge Function  ingest-health ─┐
Hevy API ◄──(elke 30 min, pg_cron)──── Supabase Edge Function  sync-hevy ──────────────┤
                                                                                        ▼
                                                     PostgreSQL (Supabase)
                                                     ├─ health.*  ruwe + genormaliseerde data
                                                     ├─ ai.*      analyse-views (daily_summary, sleep, …)
                                                     └─ app.*     eigenaar, instellingen, chat, logs
                                                                                        ▲
PWA (Vercel, map /web) ──── RPC-functies (alleen eigenaar) ─────────────────────────────┤
        └── Vraag-tab ──► Edge Function  ask ──► Claude API (tool: run_sql, read-only rol ai_reader)
```

| Onderdeel | Waar | Wat |
|---|---|---|
| `web/` | Vercel | De app: Vandaag, Training, Voeding, Trends, Vraag, Instellingen |
| `supabase/migrations/` | Supabase | Schema, views, beveiliging, cronjob |
| `supabase/functions/ingest-health` | Supabase | Ontvangt Apple Health-exports (token-beveiligd) |
| `supabase/functions/sync-hevy` | Supabase | Haalt Hevy-trainingen op (incrementeel, via events) |
| `supabase/functions/ask` | Supabase | AI-chat met Claude (data bevragen, routines maken, metingen loggen) + weekoverzicht |
| `supabase/functions/notify` | Supabase | Pushmeldingen voor routines (pg_cron elke 5 min) |
| `supabase/functions/rest-timer` | Supabase | Pushmelding als je rust tussen sets voorbij is (ook met scherm uit) |
| `supabase/functions/food` | Supabase | Zoeken en barcodes opzoeken in Open Food Facts |

### Beveiliging

- Alleen **jij** hebt toegang: de eerste account die zich registreert wordt eigenaar, en alle data-functies controleren dat. Andere accounts zien niets.
- Data-tabellen zitten in schema's die niet via de API bereikbaar zijn. De app praat alleen via RPC-functies met eigenaarscontrole.
- API-keys (Hevy, Claude) staan versleuteld in **Supabase Vault**, nooit in de browser.
- De AI draait queries als rol `ai_reader`: alleen `SELECT` op de `ai`-views, met een timeout van 8 s, en geen toegang tot secrets of ruwe tabellen.
- Het Apple Health-endpoint vereist een geheim token (vervangbaar in Instellingen).

## In gebruik nemen (eenmalig)

1. **Account aanmaken:** open de app-URL, tik "Eerste keer? Account aanmaken", vul je e-mail en een wachtwoord in en bevestig via de mail. Log daarna in.
   ➜ Zet daarna in Supabase → Authentication → Sign In / Providers → **"Allow new users to sign up" UIT**. Extra accounts hebben toch geen toegang, maar zo is het helemaal dicht.
   ➜ Zet in Supabase → Authentication → URL Configuration de **Site URL** op je app-URL, zodat bevestigingsmails naar de juiste plek linken.
2. **Op je iPhone installeren:** open de app in Safari → deelknop → **"Zet op beginscherm"**.
3. **Hevy (zonder Pro):** Hevy → Profiel → Instellingen → Export & Import Data → *Export workouts* → CSV bewaren. In de app: Training → "Hevy importeren" (of Instellingen → Hevy). Herhaal dit wanneer je wil; opnieuw importeren maakt geen dubbels. Met Hevy Pro kan je in plaats daarvan een API-key invullen voor automatische sync.
4. **Meldingen:** open de app vanaf je beginscherm → Instellingen → "Meldingen aanzetten" → Testmelding. Routines maak je in Instellingen of via de Vraag-tab ("Stuur me elke maandag om 8u een melding om mijn gewicht te loggen").
5. **Claude (AI):** maak een API-key op <https://console.anthropic.com> (met wat tegoed). In de app: Instellingen → AI → plakken → Opslaan.
6. **Apple Health (gratis):**
   - **Historiek + workouts:** Gezondheid-app → profielfoto → *Exporteer alle gezondheidsgegevens* → `export.zip`. In de app: Instellingen → Apple Health → periode kiezen → *Export kiezen*. De app leest het bestand in je browser, telt alles per uur op en ontdubbelt bronnen (iPhone + Garmin). Herhaal dit gerust; niets telt dubbel.
   - **Dagelijks automatisch:** een automatisering in de iOS-app *Opdrachten* stuurt je dagtotalen naar dezelfde URL telkens je een gekozen app opent (stappen in Instellingen → Apple Health). Geen vast tijdstip gebruiken: met een vergrendelde iPhone kan Opdrachten geen gezondheidsgegevens lezen.
   - **Waarom niet aanvinken in Gezondheid → Apps?** Dat kan alleen voor echte iPhone-apps (App Store of zelf gebouwd met Xcode op een Mac), niet voor web-apps. Komt een dag later via de export binnen, dan vervangt die gedetailleerde data de dagtotalen.
   - (Betalend alternatief: Health Auto Export Premium met REST API-automatisatie, zelfde URL en header.)
7. Controleer in Instellingen → Data → Synclogboek of alles binnenkomt.

## Functies

- **Vandaag:** beweging, training van vandaag, voeding, water (+500 ml-knop), cafeïne (+50 mg-knop), herstel, gewicht loggen, dagboek en het weekoverzicht van de AI.
- **Dagboek:** inspreken (spraakherkenning in Safari) of typen; de AI kan het lezen.
- **Routines:** terugkerende pushmeldingen; standaard staat "Weekoverzicht" op maandag 08:00.
- **Krachttraining loggen (zoals Hevy):** Training → *Lege training starten*, een schema, of een recente training herhalen. Per set: type (opwarm/normaal/falen/dropset), "Vorige" waarden (tik om over te nemen), kg en reps; afvinken start de rusttimer (−15/+15/overslaan) met geluid in de app én een pushmelding als je telefoon vergrendeld is. 🏆 bij een nieuw record (geschatte 1RM), records-overzicht na afronden, training bewaren als schema. Een lopende training blijft bewaard als je de app sluit. Cardio blijft binnenkomen via Garmin → Apple Health.
- **Voeding loggen:** Voeding → *+ Voeding toevoegen*: zoeken in je eigen producten en in **Open Food Facts** (gratis, open databank met miljoenen producten, sterk in België/Nederland), **barcode scannen** met de camera (of een foto/code typen), portie kiezen, per maaltijd. Niet gevonden → eigen product met etiketwaarden (wordt onthouden), of snel kcal/macro's invoeren. Telt mee in dashboard, trends en AI.
- **Energiebalans (Trends):** je *echte* onderhoud, berekend uit wat je at en hoe je gewichtstrend evolueert (laatste 28 volledige dagen, 7700 kcal per kg), met betrouwbaarheid en de verwachte verandering bij je kcal-doel. Gewicht wordt getoond als afgevlakte trendlijn met je losse wegingen als puntjes. Nodig: voeding op minstens 14 van de 28 dagen en een paar wegingen per week.
- **Sneller voeding loggen:** maaltijd van gisteren in één tik, ★ een maaltijd bewaren als vaste maaltijd ("Mijn ontbijt"), een vorige dag of maaltijd naar vandaag kopiëren, en recepten uit ingrediënten (met porties en gewicht na bereiden).
- **Progressie:** per oefening een voorstel (🎯) volgens dubbele progressie: herhalingen opbouwen binnen je bereik, daarna zwaarder. Bereik, stap en spiergroep pas je aan per oefening (standaard afgeleid uit je laatste trainingen). Tab *Spiergroepen* toont werksets per spiergroep deze week tegenover je gemiddelde, met de vaak aangeraden zone van 10–20 sets.
- **Agenda:** tik op de datum (Vandaag, Voeding, Dagboek) voor een maandkalender met stippen per dag (kracht, cardio, voeding, dagboek) en spring naar elke dag.
- **Gewoontes en supplementen:** dagelijks afvinken op Vandaag met reeks (🔥), beheren in Instellingen.
- **Lichaamsmaten:** gewicht, vetpercentage, taille, borst, bovenarm, dij, heup (Vandaag → Alle maten), met grafieken in Trends.
- **Recepten:** Voeding → Mijn recepten (+ Nieuw recept, bewerken, een portie loggen).
- **Back-up:** Instellingen → Data → Back-up downloaden (JSON).
- **Doelen:** aanpasbaar in Instellingen (stappen, actieve kcal, slaap, kcal, eiwit, koolhydraten, vet, vezels, water, cafeïne-max).

## Wearables (Garmin, Apple Watch, Fitbit)

Alles wat naar Apple Health schrijft werkt automatisch. Fitbit schrijft niet zelf naar Apple Health en heeft een brug-app nodig.

## Garmin

Garmin heeft geen publieke API voor particulieren. Zet in de **Garmin Connect-app → Instellingen → Gekoppelde apps → Apple Health** alles aan (activiteiten, stappen, slaap, hartslag, gewicht). Dan komt Garmin-data via Apple Health binnen.

## Dubbels

Hevy schrijft trainingen ook naar Apple Health. De app herkent dat (overlappende krachttraining ±15 min) en telt die maar één keer. Details per set komen altijd uit Hevy.

## Ontwikkelen

- Frontend: puur HTML/CSS/JS-modules, geen buildstap. Lokaal testen: `npx serve web` (inloggen werkt tegen de echte Supabase).
- Database-wijzigingen: nieuw bestand in `supabase/migrations/` en uitvoeren in Supabase → SQL Editor.
- Edge functions: `supabase functions deploy <naam> --no-verify-jwt` (de functies doen hun eigen authenticatie).

## Kosten

- Supabase Free (500 MB database, ruim genoeg voor jaren data met uur-aggregatie). Let op: een gratis project wordt na 7 dagen zonder activiteit gepauzeerd. Door de syncs is er normaal altijd activiteit.
- Vercel Hobby: gratis.
- Claude API: betalen per gebruik, typisch enkele eurocent per vraag met Sonnet.
- Hevy Pro en Health Auto Export Premium: eigen abonnementen.
