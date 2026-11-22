# CLAUDE.md — Health Hub (SimonByy/Health-Fit)

Context voor elke Claude Code-sessie in deze repo. Lees dit eerst; de README beschrijft de functies voor gebruikers.

## Eerst: kennisbank in Obsidian

Simon houdt zijn volledige context bij in zijn Obsidian-vault **SMB**:

- Pad (Windows-pc "msi"): `C:\Users\simon\Documents\ObsidianVault\SMB`
  (in Git Bash / WSL: `/c/Users/simon/Documents/ObsidianVault/SMB` of `/mnt/c/Users/simon/Documents/ObsidianVault/SMB`)
- `SMB\Claude\` bevat zijn geëxporteerde Claude-chats, projecten en geheugen, waaronder het project **"Health & fitness APP"**.

Werkwijze:
1. Begin een taak door in de vault te zoeken naar de relevante notities (bv. `grep -ril "<onderwerp>" "<vault>/Claude"`) en lees alleen wat nodig is. Zo hoeft Simon niets opnieuw uit te leggen en sparen we tokens.
2. Is de vault niet bereikbaar (cloudsessie op claude.ai/code, andere pc), ga dan verder met deze CLAUDE.md en de code, en zeg dat in één zin.
3. Spreken vault en code elkaar tegen, dan is de **code** de waarheid over wat er nu draait; de vault vertelt wat Simon **wil**. Vraag bij twijfel.
4. Schrijf niet in de vault tenzij Simon erom vraagt.

## Communicatie

- Nederlands, direct en kort. Commitberichten in het Nederlands (zie `git log`).
- Feitelijk correct; geen geschatte waarden voorstellen als echte data.

## Stack en structuur

- **Frontend** `web/`: pure HTML/CSS/JS-modules, **geen buildstap**, PWA. Gehost op Vercel (project `health-hub-simon`, `outputDirectory: web`).
- **Na elke wijziging aan de app: verhoog `CACHE` in `web/sw.js`** (bv. `health-hub-v73` → `v74`), anders zien gebruikers de oude versie.
- **Backend**: Supabase (Postgres + Edge Functions in Deno/TypeScript) in `supabase/functions/*`.
- **Schema's**: `health.*` (ruwe + genormaliseerde data), `ai.*` (read-only analyse-views voor de AI, rol `ai_reader`), `app.*` (gebruikers, instellingen, chat, logs). De app praat alleen via RPC-functies met eigenaars-/gebruikerscontrole; tabellen zijn niet rechtstreeks via de API bereikbaar.
- **Migraties**: nieuw bestand `supabase/migrations/00NN_<naam>.sql` met het volgende vrije nummer (nu na `0080`). Simon voert ze uit in Supabase → SQL Editor, tenzij er een Supabase-koppeling beschikbaar is.
- **Edge functions deployen**: `supabase functions deploy <naam> --no-verify-jwt` (functies doen hun eigen authenticatie).
- **Tests**: `cd tests && npm i && npm test` (weekmenu en boodschappenlijst).
- **Lokaal draaien**: `npx serve web` (werkt tegen de echte Supabase).
- **Deploy**: push naar `main` → Vercel zet het automatisch live in productie.

## Productregels (niet breken)

- **AI = Gemini.** Alle AI-functies (coach, menu-/trainingsplanner, briefing, Vraag het, recept-AI) gaan via Gemini; elke gebruiker brengt een eigen Gemini-key. Bouw geen nieuwe afhankelijkheid van de Claude/Anthropic API. In `ask` en `recipe-ai` zit nog Claude-code als terugval: uitfaseren waar je eraan werkt.
- **Voedingswaarden zijn echt**, nooit geschat: van echte producten (Albert Heijn voor de zondagse boodschappen, Okay midweeks, Colruyt) of Open Food Facts. Die bronnen mag je altijd opzoeken.
- **Freemium**: Free = handmatig toevoegen in beide planners, ±3 eigen workoutroutines. Premium (€5/maand, €50/jaar, €150 lifetime; betalingen later via Stripe) = alle AI-functies, onbeperkte routines, AI-routinevoorstellen, records/feedback per training, onbeperkte AI-vragen, boodschappen voorbereiden, recept uit restjes. **Free-gebruikers zien geen Premium-functies.** AI-gebruik heeft limieten per gebruiker.
- **Toegang**: multi-user met open registratie is gebouwd, maar tot de testfase (zomer 2027) en daarna de stille soft launch is Simon de enige met toegang en volledige rechten. Versoepel de toegangsvergrendeling niet zonder expliciete vraag.
- **Garmin**: onofficiële directe login (kan ooit breken; `tools/garmin_login.py`). Voor een store-app later: Garmin via Apple Health / Health Connect.
- **Training**: kracht wordt in de app gelogd (Hevy-stijl, records, rusttimer); cardio via Garmin → Apple Health. Automatisch plannen (training en weekmenu) moet uitschakelbaar blijven. Hardloopplan richting halve marathon past zich aan op basis van gelopen runs.
- **Gratis eerst**: kies gratis opties (Supabase Free, Vercel Hobby, Gemini gratis laag) tenzij Simon anders beslist.

## Veiligheid

- Geen secrets in de repo of in de browser: API-keys staan in Supabase Vault/secrets. `web/config.js` bevat alleen de publieke publishable key.
- Nooit `.env*` of `garmin.env` committen.
