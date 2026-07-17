# Hitster Cycling v3

Multiplayer Hitster: 2-6 spelers met elk een telefoon, één gedeeld spel.
Geen QR-codes meer — alles in-app. Bij het aanmaken van een spel kiest de
host een categorie: **Wielrennen** (113 kaarten), **Ajax 1995–2026** (57
kaarten) of **Algemene kennis** (56 kaarten). Ajax en Algemene kennis
groeien nog door naar 113 in een vervolgronde.

## Spelregels (kort)

1. Een speler maakt een spel aan en krijgt een 4-letter code.
2. De anderen voeren die code in op hun eigen telefoon.
3. Iedereen krijgt een **startkaart** (jaar zichtbaar) als ankerpunt op de
   eigen tijdlijn. De startkaart telt niet voor de score.
4. Wie aan de beurt is tikt op "Volgende kaart". De kaart verschijnt eerst
   dichtgeklapt (logo). Tik om de beschrijving te lezen, sluit hem weer.
5. Plaats de kaart in de juiste volgorde in jouw eigen tijdlijn.
6. **Auto-validatie**: het juiste jaar wordt automatisch gecheckt.
   Goed → kaart blijft staan met jaartal en rennernaam. Fout → kaart
   verdwijnt, geen punt.
7. Eerste speler met **5 correcte kaarten** wint.

**Tie-break gedeelde jaren**: een positie is correct als
`vorig jaar ≤ kaart-jaar ≤ volgend jaar`. Wanneer er al een kaart met
hetzelfde jaar in de tijdlijn staat, zijn meerdere gleuven correct — beide
zijden van die kaart tellen.

**Spelers**: 2 minimum, 6 maximum. **Kaarten**: 113 in de pot, gedeeld over
één spel — geen twee spelers krijgen dezelfde kaart.

**Beperkingen**:
- Spelers die hun browser refreshen op hetzelfde toestel pakken het spel
  weer op (sessie + speler-ID staan in `localStorage`).
- Spelers die overstappen naar een ander toestel of wier tab definitief
  sluit kunnen niet meer terug in het lopende spel.
- Geen reconnect-flow voor wegvallende spelers — het spel gaat door zonder
  hen, hun beurt wordt overgeslagen door de turn-index.

## Tech

- **Frontend**: vanilla HTML/CSS/JS, geen build step.
- **Backend**: Firebase Realtime Database + anonymous auth.
- **Hosting**: GitHub Pages (statische bestanden).

Bestanden:

| Bestand | Doel |
|---|---|
| `index.html` | Shell met topbar en `#view` container |
| `style.css` | Brand tokens (pink/cyan/dark) + alle UI |
| `cards.js` | Wielren-kaarten (113) als ES module export |
| `cards-ajax.js` | Ajax 1995–2026-kaarten (57, groeit naar 113) |
| `cards-algemeen.js` | Algemene-kennis-kaarten (56, groeit naar 113) |
| `themes.js` | Koppelt de drie kaartenpotten + categorie-chipstijlen |
| `app.js` | Game logica + Firebase wiring + render |
| `firebase-config.js` | Jouw Firebase project credentials |
| `database.rules.json` | RTDB security rules |
| `logo.png` | Logo (topbar + face-down kaart + iOS home icon) |

## Categorieën toevoegen

Een nieuwe categorie is een los bestand met dezelfde vorm als `cards.js`
(zelfde velden: `jaar`, `cat`, `renner`, `nat`, `race`, `kort`, `lang`,
`diff` — de veldnamen zijn generiek, de inhoud hoeft niet over wielrennen
te gaan). Exporteer het als `MOMENTEN_<NAAM>`, registreer het in
`themes.js` onder `THEMES` en voeg eventuele nieuwe `cat`-waarden toe aan
de `CATEGORY_STYLES`-lookup in datzelfde bestand.

## Firebase setup (eenmalig)

1. Maak een Firebase project aan op <https://console.firebase.google.com>.
2. **Realtime Database** → "Create Database" → kies een Europese regio
   (b.v. *Belgium (europe-west1)*) → start in *locked mode*.
3. **Authentication** → "Get started" → tab *Sign-in method* → enable
   *Anonymous*.
4. **Project settings** (tandwiel linksboven) → tab *General* → onderaan
   "Your apps" → klik `</>` om een Web app te registreren → geef hem een
   naam (b.v. "hitster-cycling") → registreer (geen Hosting nodig).
5. Kopieer de getoonde `firebaseConfig` velden naar `firebase-config.js`:
   - `apiKey`, `authDomain`, `databaseURL`, `projectId`, `appId`.
   - **Belangrijk**: `databaseURL` is verplicht. Als hij niet in de
     getoonde config staat, kopieer hem uit Realtime Database (bovenaan
     de DB-pagina, ziet er uit als
     `https://<project>-default-rtdb.europe-west1.firebasedatabase.app`).
6. **RTDB rules**: open Realtime Database → tab *Rules* → kopieer de
   inhoud van `database.rules.json` in deze repo → Publish.

## Lokaal testen

Open `index.html` via een statische server (modules werken niet via
`file://`):

```sh
python3 -m http.server 8000
# dan: http://localhost:8000
```

Twee tabs of twee toestellen op hetzelfde wifi-netwerk om met meerdere
spelers te spelen.

## Deploy naar GitHub Pages

Zet alle bestanden in de root van een repo, push, en zet Pages aan
(*Settings → Pages → Deploy from branch → main /root*). Geen build step.

## Veiligheid

De gebundelde RTDB-rules:
- Iedereen die ingelogd is (anoniem) mag een sessie aanmaken/lezen.
- Alleen de host of een ingeschreven speler mag schrijven in een sessie.
- Validatie op naam-lengte, score-bereik, status-enum.

Dit beschermt **niet** tegen gebruikers die met de browser-console
sjoemelen met hun eigen spel (b.v. score handmatig op 5 zetten). Voor een
trust-based feestspel is dat acceptabel; voor competitief gebruik zou
validatie server-side moeten (Firebase Functions of een ander backend).
