# Frontend

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 22.2.7.

## Cassis

Se [backendens instruktioner](../backend/README.md) för databas, användare och API. Starta backend innan du loggar in.

Sidans innehåll använder 98 procent av fönstrets bredd, med kolumner fördelade 15/70/15. Vänster sidoyta är reserverad för framtida metainformation och den högra visar det valda ärendets konversation; på smala skärmar visas sidoytorna under huvudinnehållet.

Alla som kan läsa ärenden kan se konversationen. Användare med rätt att ändra ärenden kan skicka inlägg och redigera sina egna. Konversationen uppdateras automatiskt var tionde sekund medan ärendet är valt. Osända utkast bevaras vid byte av ärende under den aktuella sessionen, men inte om sidan laddas om. Inläggen tas bort när ärendet tas bort.

Sökfältet visas direkt och nås även via **Sök → Fritext**. Klicka på ett diarienummer eller en handlings namn för att visa objektet. Ett ärendes handlingar sorteras efter created i stigande ordning och kan öppnas och stängas var för sig. Om ärendet bara har en handling öppnas den automatiskt; annars är raderna kollapsade. En handling som väljs i sökresultatet öppnas direkt. Fälten visas först i läsläge; välj **Ändra** för att redigera. Skapa ett ärende via **Skapa → Ärende**.

Handlingar som är manuellt kopplade från det valda ärendet visas också, en gång per handling även om flera relationer finns. Fältet **Ärende** visar handlingens ursprungliga ärende. En administratör kan ta bort varje manuell koppling utan att ta bort handlingen. Om ärendet tas bort raderas bara handlingar som tillhör det; handlingar från andra ärenden finns kvar. Ärendet kan inte tas bort om någon av dess egna handlingar innehåller dokument.

Öppna en handling för att se **Dokument i handlingen**. Den som får ändra handlingar kan välja **Importera dokument**, dra en fil från Utforskaren till släppytan eller använda filväljaren och ange namn och dokumenttyp. En fil åt gången kan importeras: PDF, DOCX, XLSX, PNG eller JPG på högst 25 MiB. Dokumenttypen väljs från värdelistan `documentType`. Högerklicka på en dokumentrad eller använd dess åtgärdsknapp för att redigera visningsnamnet, öppna, ladda ned eller ta bort dokumentet. Borttagning kräver bekräftelse och raderar även filen. Att redigera och ta bort kräver rätt att ändra handlingar. Om en äldre import saknar originalfilnamn används visningsnamnet med filändelsen. Om en fil kan visas direkt beror på webbläsaren och filtypen. En handling med dokument kan inte tas bort.

Söklistan visar även träffar i dokumentens metadata, men söker inte i filernas innehåll. Välj ett dokuments namn för att öppna dess handling och ärende. Dokumentens filtyp, storlek och filnamn visas i egna kolumner. Kolumner som inte gäller för en träff markeras med ett streck.

`classification`, `extraclass` och `recordType` väljs i alfabetiskt sorterade listor när respektive lista har värden. För `extraclass` kan flera värden läggas till. Äldre värden som inte finns i listan behöver ersättas eller tas bort innan objektet sparas; listorna konfigureras i databasen enligt backendens instruktioner.

En administratör kan via **Administrera → Hantera Användare** skapa användare eller välja en användare i listan för att ändra användarnamn, roller eller lösenord, eller ta bort användaren. Minst en roll krävs; lämna lösenordet tomt vid ändring för att behålla det. Det egna kontot kan inte tas bort och den sista administratörsrollen kan inte tas bort. Relationer hanteras via **Administrera → Hantera relationer**. Dessa menyval är inaktiverade utan motsvarande behörighet; relationslistan visas därmed inte i gränssnittet för andra roller, även om API:et tillåter dem att läsa relationer. Menybyte bevarar påbörjade administrationsformulär. Åtgärder styrs av användarens sammanlagda rättigheter; rollernas rättigheter beskrivs i backendens instruktioner.

I relationslistan visas relationernas objekt, objekttyper och relationstyp. Välj en relation för att redigera dess ändpunkter och relationstyp eller ta bort den. Automatiska ärende–handling-relationer visas men kan bara ändras via handlingen.

En administratör kan via **Administrera → Hantera värdelistor** skapa listor, ändra beskrivningar och lägga till värden. Listnamn och befintliga värden kan inte ändras eller tas bort här. Nya namn i `userRole` markeras som oanvändbara tills deras rättigheter har definierats i backend. Det första värdet i en lista kopplad till ärenden eller handlingar aktiverar validering även för befintliga objekt. Dokumenttyper måste alltid väljas från listan.

Angulars utvecklingsserver vidarebefordrar `/api` till backend på port 3000. Proxyn gäller bara utvecklingsservern; en produktionsserver behöver motsvarande konfiguration.

## Development server

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Running unit tests

To execute unit tests with the [Vitest](https://vitest.dev/) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
