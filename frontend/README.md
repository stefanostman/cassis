# Frontend

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 22.2.7.

## Cassis

Se [backendens instruktioner](../backend/README.md) för databas, användare och API. Starta backend innan du loggar in.

Sökfältet visas direkt och nås även via **Sök → Fritext**. Klicka på ett diarienummer eller en handlings namn för att visa objektet. Ett ärendes handlingar sorteras efter created i stigande ordning och kan öppnas och stängas var för sig. Om ärendet bara har en handling öppnas den automatiskt; annars är raderna kollapsade. En handling som väljs i sökresultatet öppnas direkt. Fälten visas först i läsläge; välj **Ändra** för att redigera. Skapa ett ärende via **Skapa → Ärende**.

Handlingar som är manuellt kopplade från det valda ärendet visas också, en gång per handling även om flera relationer finns. Fältet **Ärende** visar handlingens ursprungliga ärende. En administratör kan ta bort varje manuell koppling utan att ta bort handlingen. Om ärendet tas bort raderas bara handlingar som tillhör det; handlingar från andra ärenden finns kvar.

Söklistan visar ärendets diarienummer och ärenderubrik respektive handlingens namn och handlingstyp. Kolumner som inte gäller för en träff markeras med ett streck.

`classification`, `extraclass` och `recordType` väljs i alfabetiskt sorterade listor när respektive lista har värden. För `extraclass` kan flera värden läggas till. Äldre värden som inte finns i listan behöver ersättas eller tas bort innan objektet sparas; listorna konfigureras i databasen enligt backendens instruktioner.

En administratör kan via **Administrera → Hantera Användare** skapa användare eller välja en användare i listan för att ändra användarnamn, roller eller lösenord, eller ta bort användaren. Minst en roll krävs; lämna lösenordet tomt vid ändring för att behålla det. Det egna kontot kan inte tas bort och den sista administratörsrollen kan inte tas bort. Relationer hanteras via **Administrera → Hantera relationer**. Dessa menyval är inaktiverade utan motsvarande behörighet; relationslistan visas därmed inte i gränssnittet för andra roller, även om API:et tillåter dem att läsa relationer. Menybyte bevarar påbörjade administrationsformulär. Åtgärder styrs av användarens sammanlagda rättigheter; rollernas rättigheter beskrivs i backendens instruktioner.

I relationslistan visas relationernas objekt, objekttyper och relationstyp. Välj en relation för att redigera dess ändpunkter och relationstyp eller ta bort den. Automatiska ärende–handling-relationer visas men kan bara ändras via handlingen.

En administratör kan via **Administrera → Hantera värdelistor** skapa listor, ändra beskrivningar och lägga till värden. Listnamn och befintliga värden kan inte ändras eller tas bort här. Nya namn i `userRole` markeras som oanvändbara tills deras rättigheter har definierats i backend. Det första värdet i en fältkopplad lista aktiverar validering även för befintliga objekt.

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
