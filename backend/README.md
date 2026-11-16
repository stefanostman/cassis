# Cassis backend

## Kom igång

MySQL ska vara igång och `backend/.env` ska innehålla anslutningen till schemat `cassis`. Kopiera `.env.example` till `.env` och ange lösenordet om filen saknas. För en befintlig databas med den tidigare värdelisttabellen, stoppa backend och alla andra skrivningar till databasen och kör först:

```powershell
npm run migrate-value-list-objects
```

Migreringen bevarar värdena, skapar objekt med `system` som skapare och ger den befintliga användaren `cassis_admin` rollen `admin`. Den gamla tabellen sparas som `cassis_valuelists_legacy`. Om det finns andra användare utan uttryckliga rollval stoppar migreringen i stället för att tilldela roller automatiskt. Vid ett avbrott, kontrollera eventuella migreringstabeller innan du försöker igen.

Kör sedan följande i mappen `backend` (för en ny, tom databas behövs inte migreringen):

```powershell
npm install
npm run setup
```

`setup` skapar tabeller som saknas och lägger till grundlistor och användarroller som saknas. Det är inte ett migrationsverktyg för framtida schemaändringar.

För ärendekonversation i en befintlig databas: kör `npm run setup` i `backend` och starta om backend. Det skapar tabellen `case_conversation_posts` om den saknas.

För dokumentimport i en befintlig databas: kör `npm install` och `npm run setup` i `backend`, och starta om backend. Kommandot skapar `base_document` och värdelistan `documentType` om de saknas och behåller befintliga listvärden.

För en befintlig `base_document` utan kolumnen `originalFilename`: kör `npm run migrate-document-original-filename` i `backend` och starta om backend. Befintliga dokument får `NULL` eftersom deras originalnamn inte har sparats tidigare. Migreringen kan köras flera gånger.

För en befintlig databas utan `cassis_relations.objectTypes`: stoppa backend och alla andra skrivningar till databasen och kör `npm run migrate-relation-object-types` i `backend`. Migreringen fyller kolumnen från de befintliga objektens typer och kan återupptas efter avbrott. Den stannar vid saknade objekt eller motstridiga värden.

För en databas från en äldre version med `base_record.caseId`: kör först migreringen ovan och därefter `npm run migrate-record-relations` medan skrivningarna fortfarande är stoppade. Kommandot skapar saknade ärende–handling-relationer, kontrollerar kopplingarna och tar sedan bort den gamla kolumnen. Det kan köras igen och stoppar vid konflikter utan att skriva över befintliga relationer.

Skapa en användare med ett lösenord på minst åtta tecken. Kommandot frågar efter lösenordet utan att visa det:

```powershell
$secret = Read-Host "Lösenord" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
  $env:CASSIS_NEW_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  npm run create-user -- ditt_användarnamn Handläggare
} finally {
  Remove-Item Env:\CASSIS_NEW_PASSWORD -ErrorAction SilentlyContinue
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}
```

Ange en eller flera roller efter användarnamnet. Lösenordet lagras som en saltad scrypt-hash. Starta sedan med `npm run dev`. Starta Angular med `npm start` i mappen `frontend` och öppna `http://localhost:4200`.

## API och Postman

En OpenAPI 3.0-specifikation finns i [openapi.yaml](openapi.yaml) och kan importeras i exempelvis Postman.

API:et finns på `http://localhost:3000/api`. Anropa `POST /auth/login` med JSON:

```json
{ "username": "ditt_användarnamn", "password": "ditt_lösenord" }
```

Svaret innehåller `token`. Lägg den i Postmans **Authorization → Bearer Token** för följande anrop. Sessionen gäller i åtta timmar; `POST /auth/logout` avslutar den. `/health` och det tidigare `/test-messages` är fortsatt öppna.

| Metod | Sökväg | Funktion |
|---|---|---|
| GET | `/me` | Visa inloggad användares roller och rättigheter |
| GET, POST | `/users` | Lista eller skapa användare (kräver admin) |
| PUT, DELETE | `/users/:id` | Ändra eller ta bort användare (kräver admin) |
| GET, POST | `/cases` | Lista eller skapa ärenden |
| GET, PUT, DELETE | `/cases/:objectId` | Läs, ersätt eller ta bort ett ärende |
| GET, POST | `/cases/:objectId/conversation` | Läs konversationen eller skriv ett inlägg |
| PUT | `/cases/:objectId/conversation/:postId` | Redigera ett eget inlägg |
| GET, POST | `/records` | Lista eller skapa handlingar |
| GET, PUT, DELETE | `/records/:objectId` | Läs, ersätt eller ta bort en handling |
| GET | `/documents` | Lista dokumentens metadata |
| PUT, DELETE | `/documents/:objectId` | Ändra visningsnamn eller ta bort dokument och fil |
| GET | `/documents/:objectId/content` | Ladda ned en dokumentfil |
| POST | `/documents/:objectId/open` | Öppna dokumentfil i webbläsaren |
| POST | `/records/:objectId/documents` | Importera dokument till en handling |
| GET, POST | `/relations` | Lista eller skapa riktade relationer |
| PUT, DELETE | `/relations/:id` | Ändra eller ta bort en manuell relation |
| GET | `/value-lists` | Lista värdelistornas namn och värden |
| GET | `/value-list-bindings` | Visa fältens kopplingar till värdelistor |
| GET, POST | `/value-list-definitions` | Lista eller skapa värdelistor (kräver admin) |
| PUT | `/value-list-definitions/:id` | Ändra en värdelistas beskrivning (kräver admin) |
| POST | `/value-list-definitions/:id/values` | Lägg till ett värde (kräver admin) |
| GET | `/search?q=söktext` | Sök i ärenden, handlingar och dokumentens metadata |

Sökträffar innehåller `objectId`, `objectType`, `label`, `created`, `createdBy`, `diaryNumber`, `caseSentence`, `name`, `recordType`, `recordId`, `documentType`, `filetype`, `filesize`, `filename` och `originalFilename`. Fält som inte gäller för objekttypen är `null`. Sökningen omfattar dokumentens metadata och standardfält, men inte filernas innehåll.

Alla med läsbehörighet kan läsa ett ärendes konversation. Rättigheten `case:update` krävs för att skriva och redigera; endast författaren kan ändra sitt inlägg. Varje inlägg får innehålla högst 4 000 tecken. Inläggen tas bort tillsammans med ärendet. Om en användare tas bort bevaras inläggen med namnet som gällde när de skrevs, men kan inte längre redigeras.

Exempel på JSON för `POST` och `PUT`:

```json
{ "username": "anna", "password": "ett_lösenord", "roles": ["Handläggare", "Koordinator"] }
```

Vid `PUT /users/:id` måste användarnamn och minst en roll anges. Utelämna `password` för att behålla det befintliga lösenordet; ett nytt lösenord avslutar användarens övriga sessioner. API:et lämnar aldrig ut lösenord eller lösenordshashar. Det egna kontot kan inte tas bort och den sista administratörsrollen kan varken tas bort eller ändras bort. Vid byte av användarnamn behåller tidigare skapar- och ändrarfält sitt ursprungliga namn.

```json
{ "diaryNumber": "2026-1", "classification": "ABC", "extraclass": ["en", "två"], "caseSentence": "Ett ärende" }
```

```json
{ "caseId": "ärendets-objectId", "name": "Handling", "description": "Beskrivning", "recordType": "Brev" }
```

```json
{ "sourceId": "källans-objectId", "targetId": "målets-objectId", "relationType": "relaterad" }
```

`relationType` är valfri. Objekten får UUID som `objectId`, och skapar-/ändrarfält sätts utifrån inloggningen. Tiderna lagras i UTC. När ett ärende utan dokument tas bort raderas även dess handlingar och berörda relationer. Flervärdesfältet `extraclass` är en lista där varje värde får vara högst 50 tecken.

Relationens `objectTypes` lagras som källans och målets objekttyper i ordning, exempelvis `base_case-base_record`. API:et beräknar värdet när en relation skapas eller ändras; det anges inte av klienten. Vid direkt ändring av objektens typer eller relationernas ändpunkter i databasen måste även `objectTypes` hållas uppdaterat.

Varje handling får automatiskt en riktad relation från sitt ärende till handlingen, med typen `parent-child`. Kopplingen lagras endast i relationstabellen; API:ets `caseId` på handlingar hämtas därifrån. Relationens ID är handlingens `objectId` och i `GET /relations` anges den som `automatic: true`. Typen `parent-child` är reserverad för dessa relationer, som inte kan skapas, ändras eller tas bort manuellt. Om handlingens `caseId` ändras flyttas relationen automatiskt.

## Användarroller och rättigheter

Alla användare måste ha minst en roll från värdelistan `userRole`. En användare med flera roller får summan av deras rättigheter. Roller kontrolleras av API:et vid varje anrop; gränssnittet visar bara tillåtna åtgärder. Inloggning nekas om en användare saknar en roll med läsrättighet.

| Roll | Läsa och söka | Skapa ärende | Skapa handling | Ändra ärende/handling | Ta bort ärende/handling | Hantera relationer | Hantera användare | Hantera värdelistor |
|---|---|---|---|---|---|---|---|---|
| admin | Ja | Ja | Ja | Ja | Ja | Ja | Ja | Ja |
| Koordinator | Ja | Ja | Ja | Ja | Ja | Nej | Nej | Nej |
| Handläggare | Ja | Nej | Ja | Ja | Nej | Nej | Nej | Nej |
| Beslutsfattare | Ja | Nej | Nej | Ja | Nej | Nej | Nej | Nej |

Alla roller kan läsa relationer via API:et, men relationslistan i gränssnittet nås bara av användare med behörighet att hantera relationer, via **Administrera → Hantera relationer**. När en handling skapas, ändras eller tas bort hanteras dess automatiska ärenderelation som en del av den åtgärden. Användare med `record:update` får importera, byta visningsnamn och ta bort dokument. Användare hanteras i gränssnittet under **Administrera → Hantera Användare**; funktionerna kräver `admin`.

## Dokument

En handling kan innehålla flera dokument. Metadata lagras i `base_document`, som via `objectId` ärver standardfälten från `cassis_objects` och via `recordId` refererar till handlingen. Filer lagras i projektets rotkatalog `importerade dokument`, som undantas från Git. `filename` är dokumentets UUID följt av originalfilens ändelse; `originalFilename` innehåller det ursprungliga filnamnet med ändelse (högst 255 tecken), `filetype` innehåller ändelsen utan punkt och `filesize` filens storlek i byte. Originalnamnet är `NULL` för äldre importer. Ta säkerhetskopia av katalogen tillsammans med databasen.

Importera med `POST /records/:objectId/documents` som `multipart/form-data` med fälten `file`, `name` och `documentType`. Endast filändelserna pdf, docx, xlsx, png och jpg tillåts, oavsett versaler, och filen får vara högst 25 MiB (26 214 400 byte). Filinnehållet kontrolleras inte mot filtypen. `documentType` måste vara ett befintligt värde i värdelistan med samma namn, även om listan är tom. En administratör kan lägga till värden under **Hantera värdelistor**.

Ändra enbart visningsnamnet med `PUT /documents/:objectId` och `{ "name": "nytt namn" }`. `DELETE /documents/:objectId` tar bort både dokumentet och dess fil. `GET /documents/:objectId/content` returnerar filen som en nedladdning med originalfilnamnet. För att öppna i en ny flik använder gränssnittet `POST /documents/:objectId/open` med sessionens `token` i ett `application/x-www-form-urlencoded`-formulär; svaret har `Content-Disposition: inline`. Om visning stöds beror på webbläsaren och filtypen. Om originalnamnet saknas används visningsnamnet med filändelsen; tecken som inte är giltiga i Windows-filnamn ersätts med understreck.

En handling med dokument, och ett ärende som äger en sådan handling, kan inte tas bort (HTTP 409). Ta först bort dokumenten om handlingen eller ärendet ska tas bort.

## Värdelistor

`cassis_valuelists` innehåller definitionerna (`objectId`, `listName`, `listDescription`) och `cassis_valuelistelements` innehåller värdena (`objectId`, `listId`, `value`). Båda ärver standardfälten från `cassis_objects` genom sina objekt-ID:n. `listId` refererar till definitionen, och `cassis_user_roles` kopplar användare till element i `userRole`.

Kopplingarna finns i dessa kolumner och är lika för alla objekt:

| Tabell och kolumn | Värdelista |
|---|---|
| `base_case.classification_ValueList` | `classification` |
| `base_case.extraclass_ValueList` | `extraClass` |
| `case_extraclass.value_ValueList` | `extraClass` |
| `base_record.recordType_ValueList` | `recordType` |
| `base_document.documentType_ValueList` | `documentType` |

Kolumnerna innehåller listnamn och har fasta standardvärden. De är inte främmande nycklar. API:et läser kopplingarna från kolumnernas standardvärden. `extraclass` är ett flervärdesfält på ärendet, vars värden lagras i `case_extraclass`. Listnamnen är skiftlägeskänsliga.

Lista befintliga värden med:

```sql
SELECT l.listName, e.value
FROM cassis_valuelists l
JOIN cassis_valuelistelements e ON e.listId = l.objectId
ORDER BY l.listName, e.value;
```

Administratörer kan under **Administrera → Hantera värdelistor** skapa listor, ändra beskrivningar och lägga till värden. Listnamn och befintliga värden kan inte ändras eller tas bort via API:et eller gränssnittet. Nya listor kopplas inte automatiskt till något fält; fältkopplingarna konfigureras i databasen. Värdelistor används för `classification`, `extraclass`, `recordType` och `documentType`, samt för användarroller. Övriga fält har fri inmatning. Värden får inte vara tomma och måste följa respektive fälts längdbegränsning. Om flera fält använder samma lista gäller det kortaste tillåtna värdet. För ärenden och handlingar innebär en tom lista fri inmatning; för dokument krävs alltid ett listvärde. I formuläret visas värdena i svensk alfabetisk ordning. `extraclass` kan ha flera valda värden eller vara tom.

Värden kan läggas till i `userRole`, men nya rollnamn kan inte tilldelas användare eller användas för inloggning förrän deras rättigheter också definierats i `src/roles.js`. Gränssnittet markerar sådana värden. `GET /me` anger kodens tillgängliga roller i `supportedUserRoles`.

För administration returnerar `GET /value-list-definitions` även tomma listor med objekt-ID, beskrivning, värden, kopplade fält, längdgräns och om ett värde har stöd som roll. Skapa med `{ "listName": "namn", "listDescription": "beskrivning" }`, ändra beskrivning med `{ "listDescription": "ny beskrivning" }` och lägg till värde med `{ "value": "värde" }`. Listor och värden får egna objekt och skaparfält; beskrivningsändringar uppdaterar listans ändrarfält.

När en lista har värden måste varje fältvärde väljas ur den, även vid API-anrop. Befintliga värden utanför listan kan fortfarande läsas men måste ersättas eller, för `extraclass`, tas bort innan objektet kan sparas. `GET /value-lists` returnerar en array med objekt på formen `{ "listName": "classification", "value": "A" }`.

Tester körs med `npm test` i `backend` respektive `npm test -- --watch=false` i `frontend`. Backendtestet använder den konfigurerade databasen och skapar och tar bort egna tillfälliga testdata.

Detta är en första lokal utvecklingsversion: den har ingen inloggningsbegränsning eller HTTPS-konfiguration. Använd den inte exponerad mot internet eller för känsliga uppgifter utan ytterligare säkerhetsarbete.
