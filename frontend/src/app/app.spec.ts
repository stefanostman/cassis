import { TestBed } from '@angular/core/testing';
import { afterEach, vi } from 'vitest';
import { App } from './app';

const audit = {
  created: '2026-01-02 12:00:00',
  createdBy: 'anna',
  lastUpdated: '2026-01-03 12:00:00',
  lastUpdatedBy: 'anna',
};
const testCase = {
  ...audit, objectId: 'case-1', objectType: 'base_case',
  diaryNumber: 'D-1', caseSentence: 'Ärenderubrik', classification: 'ABC', extraclass: ['ett'],
};
const records = [
  { ...audit, objectId: 'record-1', objectType: 'base_record', caseId: 'case-1', name: 'Handling ett', description: 'Beskrivning', recordType: 'Brev' },
  { ...audit, objectId: 'record-2', objectType: 'base_record', caseId: 'case-1', name: 'Handling två', description: 'Andra', recordType: 'Bilaga' },
];
const allPermissions = ['read', 'case:create', 'record:create', 'case:update', 'record:update',
  'case:delete', 'record:delete', 'relation:manage', 'user:create', 'value-list:manage'];
const supportedRoles = ['admin', 'Koordinator', 'Handläggare', 'Beslutsfattare'];

describe('App', () => {
  afterEach(() => {
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    sessionStorage.clear();
    await TestBed.configureTestingModule({ imports: [App] }).compileComponents();
  });

  it('shows the login form', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('h2')?.textContent).toContain('Logga in');
  });

  it('shows an error when login fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 401, json: async () => ({ error: 'Invalid username or password' }),
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    element.querySelector('form')?.dispatchEvent(new Event('submit'));
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelector('[role="alert"]')?.textContent).toContain('Invalid username or password');
    });
  });

  async function workspace(blankNames = false, singleRecord = false, initialRecords = records,
    valueListEntries: { listName: string; value: string }[] = [],
    bindings = {
      base_case: { classification: 'classification', extraclass: 'extraClass' },
      base_record: { recordType: 'recordType' },
      base_document: { documentType: 'documentType' },
    }, permissions = allPermissions, extraCases: typeof testCase[] = [],
    initialRelations = [
      { id: 'record-1', sourceId: 'case-1', targetId: 'record-1', objectTypes: 'base_case-base_record', relationType: 'parent-child', automatic: true },
      { id: 'relation-1', sourceId: 'case-1', targetId: 'record-2', objectTypes: 'base_case-base_record', relationType: 'related', automatic: false },
    ]) {
    sessionStorage.setItem('cassisToken', 'test-token');
    sessionStorage.setItem('cassisUsername', 'test');
    let currentRecords = initialRecords.slice(0, singleRecord ? 1 : undefined).map((record) => ({ ...record }));
    let currentCase = { ...testCase };
    const documents: { objectId: string; recordId: string; name: string; documentType: string; filetype: string; filesize: number; filename: string; originalFilename: string | null }[] = [];
    let users = [
      { id: 'user-1', username: 'test', roles: ['admin'] },
      { id: 'user-2', username: 'anna', roles: ['Handläggare'] },
    ];
    let definitions = [
      { objectId: 'list-classification', listName: 'classification', listDescription: '', boundFields: ['base_case.classification'], maxValueLength: 8, values: [] as { objectId: string; value: string; supported: boolean }[] },
      { objectId: 'list-role', listName: 'userRole', listDescription: 'Användarroller', boundFields: [] as string[], maxValueLength: 255,
        values: supportedRoles.map((value, index) => ({ objectId: `role-${index}`, value, supported: true })) },
    ];
    let relations = initialRelations.map((relation) => ({ ...relation }));
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/api/documents') return { ok: true, status: 200, json: async () => [...documents] };
      if (url === '/api/records/record-1/documents' && options?.method === 'POST') {
        const body = options.body as FormData;
        const file = body.get('file') as File;
        const document = { objectId: 'document-1', recordId: 'record-1', name: String(body.get('name')),
          documentType: String(body.get('documentType')), filetype: 'pdf', filesize: file.size, filename: 'document-1.pdf', originalFilename: file.name };
        documents.push(document);
        return { ok: true, status: 201, json: async () => document };
      }
      if (url === '/api/documents/document-1' && options?.method === 'PUT') {
        const changes = JSON.parse(String(options.body));
        Object.assign(documents[0], changes);
        return { ok: true, status: 200, json: async () => ({ objectId: 'document-1', name: changes.name }) };
      }
      if (url === '/api/documents/document-1' && options?.method === 'DELETE') {
        documents.splice(0, 1);
        return { ok: true, status: 204 };
      }
      if (url === '/api/documents/document-1/content') {
        return { ok: true, status: 200, blob: async () => new Blob(['innehåll'], { type: 'application/pdf' }) };
      }
      if (url === '/api/value-list-definitions' && options?.method === 'POST') {
        const body = JSON.parse(String(options.body));
        const list = { objectId: 'new-list', listName: body.listName.trim(), listDescription: body.listDescription,
          boundFields: [], maxValueLength: 255, values: [] };
        definitions.push(list);
        return { ok: true, status: 201, json: async () => structuredClone(list) };
      }
      if (url === '/api/value-list-definitions') {
        return { ok: true, status: 200, json: async () => structuredClone(definitions) };
      }
      if (url.startsWith('/api/value-list-definitions/') && options?.method === 'PUT') {
        const objectId = url.split('/').pop()!;
        const body = JSON.parse(String(options.body));
        definitions = definitions.map((list) => list.objectId === objectId ? { ...list, listDescription: body.listDescription } : list);
        return { ok: true, status: 200, json: async () => ({ objectId, listDescription: body.listDescription }) };
      }
      if (url.startsWith('/api/value-list-definitions/') && url.endsWith('/values') && options?.method === 'POST') {
        const list = definitions.find((item) => url === `/api/value-list-definitions/${item.objectId}/values`)!;
        const body = JSON.parse(String(options.body));
        const value = { objectId: `value-${list.values.length}`, value: body.value,
          supported: list.listName !== 'userRole' || supportedRoles.includes(body.value) };
        list.values.push(value);
        return { ok: true, status: 201, json: async () => value };
      }
      if (url === '/api/relations' && (!options?.method || options.method === 'GET')) {
        return { ok: true, status: 200, json: async () => relations };
      }
      if (url === '/api/relations' && options?.method === 'POST') {
        const body = JSON.parse(String(options.body));
        const relation = { ...body, id: 'relation-2', objectTypes: 'base_record-base_case', automatic: false };
        relations.push(relation);
        return { ok: true, status: 201, json: async () => relation };
      }
      if (url.startsWith('/api/relations/') && options?.method === 'PUT') {
        const body = JSON.parse(String(options.body));
        const relation = { ...body, id: url.split('/').pop()!, objectTypes: 'base_record-base_case', automatic: false };
        relations = relations.map((entry) => entry.id === relation.id ? relation : entry);
        return { ok: true, status: 200, json: async () => relation };
      }
      if (url.startsWith('/api/relations/') && options?.method === 'DELETE') {
        relations = relations.filter((entry) => `/api/relations/${entry.id}` !== url);
        return { ok: true, status: 204 };
      }
      if (url === '/api/users' && options?.method === 'POST') {
        const body = JSON.parse(String(options.body));
        const user = { id: 'user-3', username: body.username, roles: body.roles };
        users.push(user);
        return { ok: true, status: 201, json: async () => user };
      }
      if (url === '/api/users') {
        return { ok: true, status: 200, json: async () => users };
      }
      if (url.startsWith('/api/users/') && options?.method === 'PUT') {
        const body = JSON.parse(String(options.body));
        const user = { id: url.split('/').pop()!, username: body.username, roles: body.roles };
        users = users.map((entry) => entry.id === user.id ? user : entry);
        return { ok: true, status: 200, json: async () => user };
      }
      if (url.startsWith('/api/users/') && options?.method === 'DELETE') {
        users = users.filter((entry) => `/api/users/${entry.id}` !== url);
        return { ok: true, status: 204 };
      }
      if (url === '/api/cases/case-1' && options?.method === 'PUT') {
        currentCase = { ...currentCase, ...JSON.parse(String(options.body)) };
        return { ok: true, status: 200, json: async () => currentCase };
      }
      if (url.startsWith('/api/records/') && options?.method === 'DELETE') {
        currentRecords = currentRecords.filter((record) => `/api/records/${record.objectId}` !== url);
        return { ok: true, status: 204 };
      }
      if (url === '/api/records/record-1' && options?.method === 'PUT') {
        const changes: { name: string; caseId: string; description: string; recordType: string } = JSON.parse(String(options.body));
        currentRecords = currentRecords.map((record) => record.objectId === 'record-1' ? { ...record, ...changes } : record);
        return { ok: true, status: 200, json: async () => currentRecords.find((record) => record.objectId === 'record-1') };
      }
      return {
        ok: true,
        status: 200,
        json: async () => url.startsWith('/api/search?')
          ? url === '/api/search?q=avtal.pdf'
            ? documents.filter((document) => document.originalFilename === 'avtal.pdf').map((document) => ({
                ...document, ...audit, objectType: 'base_document', diaryNumber: null, caseSentence: null, recordType: null,
              }))
            : [
              { objectId: 'case-1', objectType: 'base_case', label: 'D-1', diaryNumber: blankNames ? '' : 'D-1', caseSentence: 'Ärenderubrik', name: null, recordType: null, ...audit },
              { objectId: 'record-2', objectType: 'base_record', label: 'Handling två', diaryNumber: null, caseSentence: null, name: blankNames ? '' : 'Handling två', recordType: 'Bilaga', ...audit },
            ]
          : url.endsWith('/value-lists') ? [...valueListEntries,
            ...definitions.flatMap((list) => list.values.map((entry) => ({ listName: list.listName, value: entry.value })))]
            : url.endsWith('/value-list-bindings') ? bindings
            : url.endsWith('/me') ? { username: 'test', roles: ['admin'], permissions, supportedUserRoles: supportedRoles }
            : url.endsWith('/cases') ? [currentCase, ...extraCases]
            : url.endsWith('/records') ? currentRecords
              : [],
      };
    }));
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelector('#search-title')).not.toBeNull();
    });
    const input = element.querySelector<HTMLInputElement>('#search-query')!;
    input.value = 'test';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    element.querySelector('.search-form')?.dispatchEvent(new Event('submit'));
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelectorAll('tbody tr')).toHaveLength(2);
    });
    return { fixture, element };
  }

  it('imports a document for the open record and shows its metadata', async () => {
    const { fixture, element } = await workspace(false, true, records, [{ listName: 'documentType', value: 'Avtal' }]);
    element.querySelector<HTMLButtonElement>('.result-link')!.click();
    fixture.detectChanges();
    const section = element.querySelector<HTMLElement>('.record-content')!;
    expect(section.textContent).toContain('Dokument i handlingen');
    expect(section.textContent).toContain('Inga dokument har importerats');
    expect(section.querySelector('.empty-cell')?.getAttribute('colspan')).toBe('5');
    expect(section.querySelector('thead')?.textContent).not.toContain('Filnamn');
    const searchInput = element.querySelector<HTMLInputElement>('#search-query')!;
    searchInput.value = 'avtal.pdf';
    searchInput.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    element.querySelector<HTMLFormElement>('.search-form')!.dispatchEvent(new Event('submit'));
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelector('.search-panel tbody')?.textContent).toContain('Inga träffar');
      expect(element.querySelector<HTMLButtonElement>('.search-form button')?.disabled).toBe(false);
    });
    [...section.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Importera dokument')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const file = new File(['innehåll'], 'avtal.pdf', { type: 'application/pdf' });
    const input = section.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    const name = section.querySelector<HTMLInputElement>('input[name="documentName"]')!;
    name.value = 'Mitt avtal';
    name.dispatchEvent(new Event('input'));
    const type = section.querySelector<HTMLSelectElement>('select[name="documentType"]')!;
    type.value = 'Avtal';
    type.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    section.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit'));
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(section.textContent).toContain('Mitt avtal');
      expect(section.textContent).not.toContain('document-1.pdf');
      expect(section.querySelector('form')).toBeNull();
      expect(element.querySelector('.search-panel tbody')?.textContent).toContain('base_document');
      expect(element.querySelector('.search-panel tbody')?.textContent).toContain('avtal.pdf');
    });
    const call = vi.mocked(fetch).mock.calls.find(([url]) => url === '/api/records/record-1/documents')!;
    expect(call[1]?.headers).toEqual({ Authorization: 'Bearer test-token' });
    expect((call[1]?.body as FormData).get('documentType')).toBe('Avtal');

    element.querySelector<HTMLButtonElement>('.record-toggle')!.click();
    fixture.detectChanges();
    expect(element.querySelector<HTMLButtonElement>('.record-toggle')?.getAttribute('aria-expanded')).toBe('false');
    element.querySelector<HTMLButtonElement>('.search-panel .result-link')!.click();
    fixture.detectChanges();
    expect(element.querySelector<HTMLButtonElement>('.record-toggle')?.getAttribute('aria-expanded')).toBe('true');

    const row = section.querySelector<HTMLTableRowElement>('tbody tr')!;
    const openMenu = () => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 });
      row.dispatchEvent(event);
      fixture.detectChanges();
      expect(event.defaultPrevented).toBe(true);
    };
    openMenu();
    expect([...section.querySelectorAll('[role="menuitem"]')].map((button) => button.textContent?.trim()))
      .toEqual(['Redigera metadata', 'Öppna dokument', 'Ladda ned dokument', 'Ta bort']);
    let submittedAction = '';
    let submittedToken = '';
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function (this: HTMLFormElement) {
      submittedAction = this.action;
      submittedToken = this.querySelector<HTMLInputElement>('input[name="token"]')!.value;
    });
    [...section.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent?.trim() === 'Öppna dokument')!.click();
    expect(submittedAction).toContain('/api/documents/document-1/open');
    expect(submittedToken).toBe('test-token');

    openMenu();
    vi.stubGlobal('URL', { createObjectURL: vi.fn().mockReturnValue('blob:test'), revokeObjectURL: vi.fn() });
    let downloadName = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloadName = this.download;
    });
    [...section.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent?.trim() === 'Ladda ned dokument')!.click();
    await vi.waitFor(() => expect(downloadName).toBe('avtal.pdf'));

    openMenu();
    [...section.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent?.trim() === 'Redigera metadata')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const displayName = section.querySelector<HTMLInputElement>('input[name="editingDocumentName"]')!;
    displayName.value = 'Nytt namn';
    displayName.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    section.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit'));
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(row.textContent).toContain('Nytt namn');
      expect(section.querySelector<HTMLButtonElement>('.document-menu-trigger')?.disabled).toBe(false);
      expect(element.querySelector('.search-panel tbody')?.textContent).toContain('Nytt namn');
    });
    const edit = vi.mocked(fetch).mock.calls.find(([url, options]) => url === '/api/documents/document-1' && options?.method === 'PUT')!;
    expect(JSON.parse(String(edit[1]?.body))).toEqual({ name: 'Nytt namn' });

    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirm);
    openMenu();
    [...section.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent?.trim() === 'Ta bort')!.click();
    expect(vi.mocked(fetch).mock.calls.some(([url, options]) => url === '/api/documents/document-1' && options?.method === 'DELETE')).toBe(false);
    openMenu();
    [...section.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent?.trim() === 'Ta bort')!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(section.textContent).toContain('Inga dokument har importerats');
      expect(element.querySelector('.search-panel tbody')?.textContent).toContain('Inga träffar');
    });
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('imports a file dropped on the document form', async () => {
    const { fixture, element } = await workspace(false, true, records, [{ listName: 'documentType', value: 'Avtal' }]);
    element.querySelector<HTMLButtonElement>('.result-link')!.click();
    fixture.detectChanges();
    const section = element.querySelector<HTMLElement>('.record-content')!;
    [...section.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Importera dokument')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const zone = section.querySelector<HTMLElement>('.document-dropzone')!;
    const file = new File(['dokument'], 'avtal.PDF');
    const drag = new Event('dragover', { bubbles: true, cancelable: true });
    zone.dispatchEvent(drag);
    fixture.detectChanges();
    expect(drag.defaultPrevented).toBe(true);
    expect(zone.classList.contains('document-dragging')).toBe(true);
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [file] } });
    zone.dispatchEvent(drop);
    fixture.detectChanges();
    expect(drop.defaultPrevented).toBe(true);
    expect(zone.classList.contains('document-dragging')).toBe(false);
    expect(zone.textContent).toContain('avtal.PDF');
    const name = section.querySelector<HTMLInputElement>('input[name="documentName"]')!;
    name.value = 'Avtal';
    name.dispatchEvent(new Event('input'));
    const type = section.querySelector<HTMLSelectElement>('select[name="documentType"]')!;
    type.value = 'Avtal';
    type.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    section.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit'));
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(section.querySelector('tbody')?.textContent).toContain('Avtal');
      expect(section.querySelector('form')).toBeNull();
    });
    const call = vi.mocked(fetch).mock.calls.find(([url]) => url === '/api/records/record-1/documents')!;
    expect(((call[1]?.body as FormData).get('file') as File).name).toBe('avtal.PDF');
  });

  it('rejects invalid dropped files without keeping the previous selection', async () => {
    const { fixture, element } = await workspace(false, true, records, [{ listName: 'documentType', value: 'Avtal' }]);
    element.querySelector<HTMLButtonElement>('.result-link')!.click();
    fixture.detectChanges();
    const section = element.querySelector<HTMLElement>('.record-content')!;
    [...section.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Importera dokument')!.click();
    fixture.detectChanges();
    const zone = section.querySelector<HTMLElement>('.document-dropzone')!;
    const dropFiles = (files: File[]) => {
      const event = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: { files } });
      zone.dispatchEvent(event);
      fixture.detectChanges();
    };
    const valid = new File(['a'], 'avtal.pdf');
    dropFiles([valid]);
    expect(zone.textContent).toContain('avtal.pdf');
    dropFiles([valid, valid]);
    expect(zone.querySelector('[role="alert"]')?.textContent).toContain('en fil');
    expect(zone.querySelector('[role="status"]')).toBeNull();
    dropFiles([new File(['a'], 'skadlig.exe')]);
    expect(zone.querySelector('[role="alert"]')?.textContent).toContain('Filtypen stöds inte');
    const tooLarge = new File(['a'], 'stor.pdf');
    Object.defineProperty(tooLarge, 'size', { value: 25 * 1024 * 1024 + 1 });
    dropFiles([tooLarge]);
    expect(zone.querySelector('[role="alert"]')?.textContent).toContain('högst 25 MiB');
    dropFiles([]);
    expect(zone.querySelector('[role="alert"]')?.textContent).toContain('Välj eller släpp');
    expect(section.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  });

  it('does not offer document import without record update permission', async () => {
    const { fixture, element } = await workspace(false, true, records, [], undefined, ['read']);
    element.querySelector<HTMLButtonElement>('.result-link')!.click();
    fixture.detectChanges();
    expect(element.querySelector('.record-content')?.textContent).toContain('Dokument i handlingen');
    expect(element.querySelector('.record-content')?.textContent).not.toContain('Importera dokument');
  });

  function chooseMenu(element: HTMLElement, menu: string, option: string): void {
    const details = [...element.querySelectorAll<HTMLDetailsElement>('.main-menu details')]
      .find((item) => item.querySelector('summary')?.textContent?.trim() === menu)!;
    details.querySelector('summary')!.click();
    const button = [...details.querySelectorAll('button')].find((item) => item.textContent?.trim() === option)!;
    button.click();
  }

  it('shows search metadata and opens a record with its case', async () => {
    const { fixture, element } = await workspace();
    expect(element.querySelector('thead')?.textContent).toContain('object_typ');
    expect(element.querySelector('thead')?.textContent).toContain('createdBy');
    expect(element.querySelector('tbody')?.textContent).toContain(audit.created);
    expect(element.querySelector('tbody')?.textContent).toContain(audit.createdBy);
    const headings = [...element.querySelectorAll('thead th')].map((cell) => cell.textContent?.trim());
    expect(headings).toEqual(['object_typ', 'created', 'createdBy', 'diary_number', 'CaseSentence', 'name', 'recordType',
      'documentType', 'filetype', 'filesize', 'filename', 'originalFilename']);
    const rows = [...element.querySelectorAll('tbody tr')].map((row) =>
      [...row.querySelectorAll('td')].map((cell) => cell.textContent?.trim()));
    expect(rows[0].slice(3)).toEqual(['D-1', 'Ärenderubrik', '—', '—', '—', '—', '—', '—', '—']);
    expect(rows[1].slice(3)).toEqual(['—', '—', 'Handling två', 'Bilaga', '—', '—', '—', '—', '—']);
    const result = [...element.querySelectorAll<HTMLButtonElement>('.result-link')].find((button) => button.textContent?.includes('Handling två'));
    result?.click();
    fixture.detectChanges();
    expect(element.querySelector('section[aria-labelledby="case-title"] .object-title')?.textContent).toContain('Ärenderubrik');
    const recordButtons = [...element.querySelectorAll<HTMLButtonElement>('.record-toggle')];
    expect(recordButtons.map((button) => button.getAttribute('aria-expanded'))).toEqual(['false', 'true']);
    expect(recordButtons[1].textContent).toContain('Handling två');
    expect(element.querySelector('section[aria-labelledby="record-title"] .field-list')?.textContent).toContain('recordType');
    expect(element.querySelector('section[aria-labelledby="record-title"] .field-list dd')?.textContent?.trim()).toBe('D-1');
    expect(element.querySelector('section[aria-labelledby="record-title"] input')).toBeNull();
    expect(element.textContent).not.toContain('objectId');
    expect(element.textContent).not.toContain('case-1');
    expect(element.textContent).not.toContain('record-2');
  });

  it('lets the user select objects without a diary number or name', async () => {
    const { fixture, element } = await workspace(true);
    const links = [...element.querySelectorAll<HTMLButtonElement>('.result-link')];
    expect(links.map((link) => link.textContent?.trim())).toEqual(['(utan diarienummer)', '(utan namn)']);
    links[0].click();
    fixture.detectChanges();
    expect(element.querySelector('section[aria-labelledby="case-title"] .object-title')?.textContent).toContain('Ärenderubrik');
    links[1].click();
    fixture.detectChanges();
    expect(element.querySelectorAll('.record-toggle')[1].getAttribute('aria-expanded')).toBe('true');
  });

  it('starts records collapsed and allows multiple rows to open and close independently', async () => {
    const { fixture, element } = await workspace();
    element.querySelector<HTMLButtonElement>('.result-link')?.click();
    fixture.detectChanges();
    const recordSection = element.querySelector<HTMLElement>('section[aria-labelledby="record-title"]')!;
    const buttons = [...recordSection.querySelectorAll<HTMLButtonElement>('.record-toggle')];
    expect(buttons.map((button) => button.getAttribute('aria-expanded'))).toEqual(['false', 'false']);
    buttons[0].click();
    fixture.detectChanges();
    buttons[1].click();
    fixture.detectChanges();
    expect(buttons.map((button) => button.getAttribute('aria-expanded'))).toEqual(['true', 'true']);
    expect(recordSection.querySelectorAll('.record-content:not([hidden]) .field-list')).toHaveLength(2);
    buttons[1].click();
    fixture.detectChanges();
    expect(buttons.map((button) => button.getAttribute('aria-expanded'))).toEqual(['true', 'false']);
    const firstContent = recordSection.querySelector<HTMLElement>('.record-content:not([hidden])')!;
    const edit = [...firstContent.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Ändra');
    edit?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(recordSection.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe('Handling ett');
    expect(element.querySelector<HTMLButtonElement>('.result-link')?.disabled).toBe(true);
    const cancel = [...recordSection.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Avbryt');
    cancel?.click();
    fixture.detectChanges();
    expect(recordSection.querySelector('input')).toBeNull();
    expect(buttons[0].getAttribute('aria-expanded')).toBe('true');
    expect(firstContent.textContent).toContain('Beskrivning');
  });

  it('opens a single record when its case is selected but allows it to be closed', async () => {
    const { fixture, element } = await workspace(false, true);
    element.querySelector<HTMLButtonElement>('.result-link')?.click();
    fixture.detectChanges();
    const button = element.querySelector<HTMLButtonElement>('.record-toggle')!;
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(element.querySelector('.record-content:not([hidden])')).not.toBeNull();
    button.click();
    fixture.detectChanges();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    element.querySelector('.search-form')?.dispatchEvent(new Event('submit'));
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelector<HTMLButtonElement>('.result-link')?.disabled).toBe(false);
    });
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens the remaining record after deleting one of two', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    const { fixture, element } = await workspace();
    element.querySelector<HTMLButtonElement>('.result-link')?.click();
    fixture.detectChanges();
    element.querySelector<HTMLButtonElement>('.record-toggle')?.click();
    fixture.detectChanges();
    const remove = element.querySelector<HTMLButtonElement>('.record-content:not([hidden]) .button-danger')!;
    remove.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      const buttons = element.querySelectorAll<HTMLButtonElement>('.record-toggle');
      expect(buttons).toHaveLength(1);
      expect(buttons[0].textContent).toContain('Handling två');
      expect(buttons[0].getAttribute('aria-expanded')).toBe('true');
    });
  });

  it('sorts the selected case records by creation time ascending', async () => {
    const unsorted = [
      { ...records[0], name: 'Senare', created: '2026-01-03 08:00:00', createdBy: 'anna' },
      { ...records[1], name: 'Tidig', created: '2025-12-31 23:59:59', createdBy: 'zara' },
      { ...records[0], objectId: 'record-3', name: 'Mellan', created: '2026-01-03 07:59:59' },
      { ...records[0], objectId: 'record-4', name: 'Samma tid', created: '2026-01-03 07:59:59' },
      { ...records[0], objectId: 'record-5', caseId: 'other-case', name: 'Annat ärende', created: '2024-01-01 00:00:00' },
    ];
    const { fixture, element } = await workspace(false, false, unsorted);
    element.querySelector<HTMLButtonElement>('.result-link')?.click();
    fixture.detectChanges();
    const names = [...element.querySelectorAll('.record-toggle > span:first-child')]
      .map((name) => name.textContent?.trim());
    expect(names).toEqual(['Tidig', 'Mellan', 'Samma tid', 'Senare']);
  });

  it('shows manually linked records once, identifies their owning case and unlinks individual relations', async () => {
    const otherCase = { ...testCase, objectId: 'case-2', diaryNumber: 'D-2', caseSentence: 'Annat ärende' };
    const linked = { ...records[1], objectId: 'linked-1', caseId: 'case-2', name: 'Kopplad handling', created: '2025-01-01' };
    const reversed = { ...records[1], objectId: 'reverse-1', caseId: 'case-2', name: 'Omvänd koppling' };
    const links = [
      { id: 'link-a', sourceId: 'case-1', targetId: 'linked-1', objectTypes: 'base_case-base_record', relationType: 'relaterad', automatic: false },
      { id: 'link-b', sourceId: 'case-1', targetId: 'linked-1', objectTypes: 'base_case-base_record', relationType: 'bilaga', automatic: false },
      { id: 'link-reverse', sourceId: 'reverse-1', targetId: 'case-1', objectTypes: 'base_record-base_case', relationType: 'relaterad', automatic: false },
    ];
    const { fixture, element } = await workspace(false, false, [records[0], linked, reversed], [], undefined,
      allPermissions, [otherCase], links);
    element.querySelector<HTMLButtonElement>('.result-link')!.click();
    fixture.detectChanges();
    const toggles = [...element.querySelectorAll<HTMLButtonElement>('.record-toggle')];
    expect(toggles.map((button) => button.querySelector('span')?.textContent?.trim()))
      .toEqual(['Kopplad handling', 'Handling ett']);
    toggles[0].click();
    fixture.detectChanges();
    const content = element.querySelector<HTMLElement>('.record-content:not([hidden])')!;
    expect(content.querySelector('.field-list dd')?.textContent?.trim()).toBe('D-2');
    expect([...content.querySelectorAll('button')].map((button) => button.textContent?.trim()))
      .toEqual(['Importera dokument', 'Ändra', 'Ta bort koppling (relaterad)', 'Ta bort koppling (bilaga)']);
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    [...content.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('relaterad'))!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelectorAll('.record-toggle')).toHaveLength(2);
      expect(content.textContent).not.toContain('Ta bort koppling (relaterad)');
    });
    [...content.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('bilaga'))!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      const remaining = element.querySelectorAll<HTMLButtonElement>('.record-toggle');
      expect(remaining).toHaveLength(1);
      expect(remaining[0].textContent).toContain('Handling ett');
      expect(remaining[0].getAttribute('aria-expanded')).toBe('true');
    });
    expect(vi.mocked(fetch).mock.calls.filter(([url, options]) =>
      typeof url === 'string' && url.startsWith('/api/relations/') && options?.method === 'DELETE').map(([url]) => url))
      .toEqual(['/api/relations/link-a', '/api/relations/link-b']);
    expect(vi.mocked(fetch).mock.calls.some(([url, options]) => typeof url === 'string' && url.startsWith('/api/records/') && options?.method === 'DELETE')).toBe(false);
  });

  it('shows a single linked record to read-only users without offering unlink or delete', async () => {
    const otherCase = { ...testCase, objectId: 'case-2', diaryNumber: 'D-2' };
    const linked = { ...records[1], caseId: 'case-2' };
    const relations = [
      { id: 'link', sourceId: 'case-1', targetId: linked.objectId, objectTypes: 'base_case-base_record', relationType: '', automatic: false },
    ];
    const { fixture, element } = await workspace(false, false, [linked], [], undefined, ['read'], [otherCase], relations);
    element.querySelector<HTMLButtonElement>('.result-link')!.click();
    fixture.detectChanges();
    expect(element.querySelector<HTMLButtonElement>('.record-toggle')?.getAttribute('aria-expanded')).toBe('true');
    const content = element.querySelector<HTMLElement>('.record-content:not([hidden])')!;
    expect(content.querySelector('.field-list dd')?.textContent?.trim()).toBe('D-2');
    expect(content.querySelectorAll('button')).toHaveLength(0);
  });

  it('updates the displayed case immediately when an administrator creates a manual link', async () => {
    const otherCase = { ...testCase, objectId: 'case-2', diaryNumber: 'D-2' };
    const linked = { ...records[1], caseId: 'case-2' };
    const { fixture, element } = await workspace(false, false, [records[0], linked], [], undefined,
      allPermissions, [otherCase], []);
    element.querySelector<HTMLButtonElement>('.result-link')!.click();
    fixture.detectChanges();
    expect(element.querySelectorAll('.record-toggle')).toHaveLength(1);
    chooseMenu(element, 'Administrera', 'Hantera relationer');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect([...element.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === 'Ny relation')?.disabled).toBe(false);
    });
    const source = element.querySelector<HTMLSelectElement>('select[name="sourceId"]')!;
    const target = element.querySelector<HTMLSelectElement>('select[name="targetId"]')!;
    source.value = 'case-1';
    source.dispatchEvent(new Event('change'));
    target.value = linked.objectId;
    target.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    element.querySelector<HTMLFormElement>('.relation-form')!.dispatchEvent(new Event('submit'));
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelectorAll('.record-toggle')).toHaveLength(2);
      expect(element.querySelector('section[aria-labelledby="record-title"]')?.textContent).toContain('Handling två');
    });
  });

  it('keeps the viewed case when saving an externally linked record', async () => {
    const otherCase = { ...testCase, objectId: 'case-2', diaryNumber: 'D-2' };
    const linked = { ...records[0], caseId: 'case-2' };
    const relations = [
      { id: 'link', sourceId: 'case-1', targetId: linked.objectId, objectTypes: 'base_case-base_record', relationType: 'related', automatic: false },
    ];
    const { fixture, element } = await workspace(false, false, [linked], [], undefined, allPermissions, [otherCase], relations);
    element.querySelector<HTMLButtonElement>('.result-link')!.click();
    fixture.detectChanges();
    const content = element.querySelector<HTMLElement>('.record-content:not([hidden])')!;
    [...content.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Ändra')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const name = content.querySelector<HTMLInputElement>('input[name="name"]')!;
    name.value = 'Uppdaterad';
    name.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    content.querySelector('form')!.dispatchEvent(new Event('submit'));
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelector('.record-toggle')?.textContent).toContain('Uppdaterad');
      expect(element.querySelector('.object-title')?.textContent).toContain('Ärenderubrik');
      expect(element.querySelector('.record-content:not([hidden]) .field-list dd')?.textContent?.trim()).toBe('D-2');
    });
  });

  it('shows automatic relations without permitting changes or deletion', async () => {
    const { fixture, element } = await workspace();
    chooseMenu(element, 'Administrera', 'Hantera relationer');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelectorAll('[aria-label="Relationer"] button')).toHaveLength(2);
      expect(element.querySelector<HTMLButtonElement>('[aria-label="Relationer"] button')?.disabled).toBe(false);
    });
    element.querySelector<HTMLButtonElement>('[aria-label="Relationer"] button')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(element.querySelector('.admin-panel')?.textContent).toContain('Automatisk ärende–handling-relation');
    expect(element.querySelector<HTMLSelectElement>('select[name="sourceId"]')?.disabled).toBe(true);
    expect(element.querySelector<HTMLInputElement>('input[name="relationType"]')?.disabled).toBe(true);
    const buttons = [...element.querySelector<HTMLFormElement>('.relation-form')!.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.every((button) => button.disabled)).toBe(true);
  });

  it('edits and deletes a selected manual relation while protecting drafts', async () => {
    const { fixture, element } = await workspace();
    chooseMenu(element, 'Administrera', 'Hantera relationer');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelector<HTMLButtonElement>('[aria-label="Relationer"] button')?.disabled).toBe(false);
    });
    const buttons = [...element.querySelectorAll<HTMLButtonElement>('[aria-label="Relationer"] button')];
    buttons[1].click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const source = element.querySelector<HTMLSelectElement>('select[name="sourceId"]')!;
    const target = element.querySelector<HTMLSelectElement>('select[name="targetId"]')!;
    const type = element.querySelector<HTMLInputElement>('input[name="relationType"]')!;
    expect(type.value).toBe('related');
    source.value = 'record-1';
    source.dispatchEvent(new Event('change'));
    target.value = 'case-1';
    target.dispatchEvent(new Event('change'));
    type.value = 'ändrad';
    type.dispatchEvent(new Event('input'));
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
    buttons[0].click();
    fixture.detectChanges();
    expect(type.value).toBe('ändrad');
    element.querySelector<HTMLFormElement>('.relation-form')!.dispatchEvent(new Event('submit'));
    await vi.waitFor(() => {
      fixture.detectChanges();
      const call = vi.mocked(fetch).mock.calls.find(([url, options]) => url === '/api/relations/relation-1' && options?.method === 'PUT');
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ sourceId: 'record-1', targetId: 'case-1', relationType: 'ändrad' });
      expect(element.querySelector('[aria-label="Relationer"]')?.textContent).toContain('base_record-base_case');
    });
    vi.mocked(confirm).mockReturnValue(true);
    [...element.querySelectorAll<HTMLButtonElement>('.relation-form button')]
      .find((button) => button.textContent?.trim() === 'Ta bort relation')!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(vi.mocked(fetch).mock.calls.some(([url, options]) => url === '/api/relations/relation-1' && options?.method === 'DELETE')).toBe(true);
      expect(element.querySelectorAll('[aria-label="Relationer"] button')).toHaveLength(1);
      expect(element.querySelector('.relation-form [role="status"]')?.textContent).toContain('tagits bort');
    });
  });

  it('creates a relation from the detail form', async () => {
    const { fixture, element } = await workspace();
    chooseMenu(element, 'Administrera', 'Hantera relationer');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelector<HTMLButtonElement>('[aria-label="Relationer"] button')?.disabled).toBe(false);
    });
    const source = element.querySelector<HTMLSelectElement>('select[name="sourceId"]')!;
    const target = element.querySelector<HTMLSelectElement>('select[name="targetId"]')!;
    source.value = 'record-1';
    source.dispatchEvent(new Event('change'));
    target.value = 'case-1';
    target.dispatchEvent(new Event('change'));
    const type = element.querySelector<HTMLInputElement>('input[name="relationType"]')!;
    type.value = 'related';
    type.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    element.querySelector<HTMLFormElement>('.relation-form')!.dispatchEvent(new Event('submit'));
    await vi.waitFor(() => {
      fixture.detectChanges();
      const call = vi.mocked(fetch).mock.calls.find(([url, options]) => url === '/api/relations' && options?.method === 'POST');
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ sourceId: 'record-1', targetId: 'case-1', relationType: 'related' });
      expect(element.querySelectorAll('[aria-label="Relationer"] button')).toHaveLength(3);
      expect(type.value).toBe('');
    });
  });

  it('creates a user with multiple selected roles', async () => {
    const { fixture, element } = await workspace();
    chooseMenu(element, 'Administrera', 'Hantera Användare');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelectorAll('[aria-label="Användare"] .user-list-item')).toHaveLength(2);
    });
    const form = [...element.querySelectorAll<HTMLFormElement>('form')].find((item) => item.querySelector('input[name="newUsername"]'))!;
    const username = form.querySelector<HTMLInputElement>('input[name="newUsername"]')!;
    const password = form.querySelector<HTMLInputElement>('input[name="newPassword"]')!;
    username.value = 'alice';
    username.dispatchEvent(new Event('input'));
    password.value = 'a-long-password';
    password.dispatchEvent(new Event('input'));
    const choices = [...form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    for (const choice of choices.filter((item) => ['Handläggare', 'Beslutsfattare'].some((role) => item.parentElement?.textContent?.includes(role)))) {
      choice.checked = true;
      choice.dispatchEvent(new Event('change'));
    }
    fixture.detectChanges();
    form.dispatchEvent(new Event('submit'));
    await vi.waitFor(() => {
      fixture.detectChanges();
      const call = vi.mocked(fetch).mock.calls.find(([url, options]) => url === '/api/users' && options?.method === 'POST');
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]?.body))).toEqual({
        username: 'alice', password: 'a-long-password', roles: ['Beslutsfattare', 'Handläggare'],
      });
      expect(form.querySelector('[role="status"]')?.textContent).toContain('alice');
      expect(password.value).toBe('');
    });
  });

  it('selects, updates and removes a user without exposing a password', async () => {
    const { fixture, element } = await workspace();
    chooseMenu(element, 'Administrera', 'Hantera Användare');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelectorAll('[aria-label="Användare"] .user-list-item')).toHaveLength(2);
    });
    const userButtons = [...element.querySelectorAll<HTMLButtonElement>('[aria-label="Användare"] .user-list-item')];
    expect(userButtons.map((button) => button.querySelector('strong')?.textContent)).toEqual(['anna', 'test']);
    userButtons[0].click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const form = element.querySelector<HTMLInputElement>('input[name="newUsername"]')!.form!;
    const username = form.querySelector<HTMLInputElement>('input[name="newUsername"]')!;
    const password = form.querySelector<HTMLInputElement>('input[name="newPassword"]')!;
    expect(username.value).toBe('anna');
    expect(password.value).toBe('');
    expect([...form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((input) => input.parentElement?.textContent?.includes('Handläggare'))?.checked).toBe(true);
    username.value = 'anna2';
    username.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    form.dispatchEvent(new Event('submit'));
    await vi.waitFor(() => {
      fixture.detectChanges();
      const call = vi.mocked(fetch).mock.calls.find(([url, options]) => url === '/api/users/user-2' && options?.method === 'PUT');
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ username: 'anna2', roles: ['Handläggare'] });
      expect(element.querySelector('[aria-label="Användare"] .user-list-item strong')?.textContent).toBe('anna2');
    });
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    [...form.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Ta bort användare'))!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(vi.mocked(fetch).mock.calls.some(([url, options]) => url === '/api/users/user-2' && options?.method === 'DELETE')).toBe(true);
      expect(element.querySelectorAll('[aria-label="Användare"] .user-list-item')).toHaveLength(1);
      expect(element.querySelector('[role="status"]')?.textContent).toContain('tagits bort');
    });
  });

  it('protects unsaved changes and disables deletion of the signed-in user', async () => {
    const { fixture, element } = await workspace();
    chooseMenu(element, 'Administrera', 'Hantera Användare');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelectorAll('[aria-label="Användare"] .user-list-item')).toHaveLength(2);
    });
    const buttons = [...element.querySelectorAll<HTMLButtonElement>('[aria-label="Användare"] .user-list-item')];
    buttons[0].click();
    fixture.detectChanges();
    await fixture.whenStable();
    const input = element.querySelector<HTMLInputElement>('input[name="newUsername"]')!;
    input.value = 'ändrat utkast';
    input.dispatchEvent(new Event('input'));
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
    [...element.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Logga ut')!.click();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/auth/logout')).toBe(false);
    buttons[1].click();
    fixture.detectChanges();
    expect(input.value).toBe('ändrat utkast');
    vi.mocked(confirm).mockReturnValue(true);
    buttons[1].click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(input.value).toBe('test');
    const remove = [...element.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Ta bort användare')!;
    expect(remove.disabled).toBe(true);
  });

  it('only shows actions permitted to a Handläggare', async () => {
    const { fixture, element } = await workspace(false, false, records, [], undefined,
      ['read', 'record:create', 'case:update', 'record:update']);
    element.querySelector<HTMLButtonElement>('.result-link')!.click();
    fixture.detectChanges();
    const buttons = [...element.querySelectorAll('button')].map((button) => button.textContent?.trim());
    expect(buttons).toContain('Ny handling');
    expect(buttons).toContain('Ändra');
    expect(buttons).not.toContain('Nytt ärende');
    expect(buttons).not.toContain('Ta bort');
    expect(element.querySelector('input[name="newUsername"]')).toBeNull();
    expect(element.querySelector('.relation-form')).toBeNull();
    const menuOptions = [...element.querySelectorAll<HTMLButtonElement>('.menu-options button')];
    expect(menuOptions.find((button) => button.textContent?.trim() === 'Ärende')?.disabled).toBe(true);
    expect(menuOptions.find((button) => button.textContent?.trim() === 'Hantera Användare')?.disabled).toBe(true);
    expect(menuOptions.find((button) => button.textContent?.trim() === 'Hantera relationer')?.disabled).toBe(true);
    expect(menuOptions.find((button) => button.textContent?.trim() === 'Hantera värdelistor')?.disabled).toBe(true);
    expect(menuOptions.find((button) => button.textContent?.trim() === 'Fritext')?.disabled).toBe(false);
  });

  it('creates a value list, changes its description and adds sorted values', async () => {
    const { fixture, element } = await workspace();
    chooseMenu(element, 'Administrera', 'Hantera värdelistor');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelectorAll('[aria-label="Värdelistor"] button')).toHaveLength(2);
    });
    expect(element.querySelector('[aria-label="Värdelistor"]')?.closest('[hidden]')).toBeNull();
    expect(element.querySelector('[aria-label="Värdelistor"]')?.closest('form')).toBeNull();
    const name = element.querySelector<HTMLInputElement>('input[name="listName"]')!;
    const description = element.querySelector<HTMLInputElement>('input[name="listDescription"]')!;
    name.value = 'ämne';
    name.dispatchEvent(new Event('input'));
    description.value = 'Ämnen';
    description.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    name.form!.dispatchEvent(new Event('submit'));
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(name.readOnly).toBe(true);
      expect(element.querySelector('[aria-label="Värdelistor"]')?.textContent).toContain('ämne');
    });
    description.value = 'Uppdaterad beskrivning';
    description.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    name.form!.dispatchEvent(new Event('submit'));
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(vi.mocked(fetch).mock.calls.some(([url, options]) =>
        url === '/api/value-list-definitions/new-list' && options?.method === 'PUT'
        && JSON.stringify(JSON.parse(String(options.body))) === JSON.stringify({ listDescription: 'Uppdaterad beskrivning' }))).toBe(true);
    });
    const value = element.querySelector<HTMLInputElement>('input[name="listValue"]')!;
    for (const entry of ['Ö', 'A']) {
      value.value = entry;
      value.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      value.form!.dispatchEvent(new Event('submit'));
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(value.value).toBe('');
        expect(element.querySelector<HTMLButtonElement>('[aria-label="Värdelistor"] button')?.disabled).toBe(false);
      });
    }
    expect([...element.querySelectorAll('[aria-label="Värden"] li')].map((item) => item.textContent?.trim())).toEqual(['A', 'Ö']);
    const valuePanel = element.querySelector<HTMLElement>('[aria-label="Värdelistor"]')!.parentElement!;
    expect([...valuePanel.querySelectorAll('button')].some((button) => button.textContent?.includes('Ta bort'))).toBe(false);
  });

  it('warns before activating a bound list and refreshes the open case editor', async () => {
    const { fixture, element } = await workspace();
    element.querySelector<HTMLButtonElement>('.result-link')!.click();
    fixture.detectChanges();
    const caseSection = element.querySelector<HTMLElement>('section[aria-labelledby="case-title"]')!;
    [...caseSection.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Ändra')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    chooseMenu(element, 'Administrera', 'Hantera värdelistor');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelectorAll('[aria-label="Värdelistor"] button')).toHaveLength(2);
    });
    [...element.querySelectorAll<HTMLButtonElement>('[aria-label="Värdelistor"] button')]
      .find((button) => button.textContent?.includes('classification'))!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const value = element.querySelector<HTMLInputElement>('input[name="listValue"]')!;
    expect(value.maxLength).toBe(8);
    value.value = '1.2.3';
    value.dispatchEvent(new Event('input'));
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
    value.form!.dispatchEvent(new Event('submit'));
    expect(vi.mocked(fetch).mock.calls.some(([url, options]) =>
      url === '/api/value-list-definitions/list-classification/values' && options?.method === 'POST')).toBe(false);
    vi.mocked(confirm).mockReturnValue(true);
    value.form!.dispatchEvent(new Event('submit'));
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(caseSection.querySelector('select[name="classification"]')).not.toBeNull();
    });
    expect([...caseSection.querySelector<HTMLSelectElement>('select[name="classification"]')!.options].map((option) => option.value))
      .toEqual(['', 'ABC', '1.2.3']);
    expect(caseSection.querySelector<HTMLInputElement>('input[name="caseSentence"]')?.value).toBe('Ärenderubrik');
  });

  it('preserves an unsaved value-list draft when changing selection or logging out is cancelled', async () => {
    const { fixture, element } = await workspace();
    chooseMenu(element, 'Administrera', 'Hantera värdelistor');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelectorAll('[aria-label="Värdelistor"] button')).toHaveLength(2);
    });
    const lists = [...element.querySelectorAll<HTMLButtonElement>('[aria-label="Värdelistor"] button')];
    lists[0].click();
    fixture.detectChanges();
    await fixture.whenStable();
    const description = element.querySelector<HTMLInputElement>('input[name="listDescription"]')!;
    description.value = 'Osparad beskrivning';
    description.dispatchEvent(new Event('input'));
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
    lists[1].click();
    [...element.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Logga ut')!.click();
    fixture.detectChanges();
    expect(description.value).toBe('Osparad beskrivning');
    expect(lists[0].getAttribute('aria-pressed')).toBe('true');
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/auth/logout')).toBe(false);
  });

  it('marks newly added unsupported roles and prevents assigning them', async () => {
    const { fixture, element } = await workspace();
    chooseMenu(element, 'Administrera', 'Hantera värdelistor');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelectorAll('[aria-label="Värdelistor"] button')).toHaveLength(2);
    });
    [...element.querySelectorAll<HTMLButtonElement>('[aria-label="Värdelistor"] button')]
      .find((button) => button.textContent?.includes('userRole'))!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const value = element.querySelector<HTMLInputElement>('input[name="listValue"]')!;
    value.value = 'Ny roll';
    value.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    value.form!.dispatchEvent(new Event('submit'));
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelector('[aria-label="Värden"]')?.textContent).toContain('saknar definierade rättigheter');
      expect(element.querySelector<HTMLButtonElement>('[aria-label="Värdelistor"] button')?.disabled).toBe(false);
    });
    chooseMenu(element, 'Administrera', 'Hantera Användare');
    await vi.waitFor(() => {
      fixture.detectChanges();
      const option = [...element.querySelectorAll<HTMLInputElement>('.user-roles input')]
        .find((input) => input.parentElement?.textContent?.includes('Ny roll'));
      expect(option?.disabled).toBe(true);
      expect(option?.parentElement?.textContent).toContain('saknar definierade rättigheter');
    });
  });

  it('navigates between menus without losing drafts, search results or selection', async () => {
    const { fixture, element } = await workspace();
    element.querySelector<HTMLButtonElement>('.result-link')!.click();
    fixture.detectChanges();
    chooseMenu(element, 'Administrera', 'Hantera Användare');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelectorAll('[aria-label="Användare"] .user-list-item')).toHaveLength(2);
    });
    const admin = element.querySelector<HTMLElement>('.admin-panel')!;
    expect(admin.hidden).toBe(false);
    const username = admin.querySelector<HTMLInputElement>('input[name="newUsername"]')!;
    username.value = 'utkast';
    username.dispatchEvent(new Event('input'));
    chooseMenu(element, 'Administrera', 'Hantera relationer');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelector<HTMLButtonElement>('[aria-label="Relationer"] button')?.disabled).toBe(false);
    });
    expect(admin.textContent).toContain('base_case-base_record');
    const relationType = admin.querySelector<HTMLInputElement>('input[name="relationType"]')!;
    relationType.value = 'utkast till relation';
    relationType.dispatchEvent(new Event('input'));
    chooseMenu(element, 'Sök', 'Fritext');
    fixture.detectChanges();
    expect(admin.hidden).toBe(true);
    expect(document.activeElement).toBe(element.querySelector('#search-query'));
    expect(element.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(element.querySelector('.object-title')?.textContent).toContain('Ärenderubrik');
    chooseMenu(element, 'Administrera', 'Hantera Användare');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelector<HTMLButtonElement>('[aria-label="Användare"] .user-list-item')?.disabled).toBe(false);
    });
    expect(username.value).toBe('utkast');
    chooseMenu(element, 'Administrera', 'Hantera relationer');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelector<HTMLButtonElement>('[aria-label="Relationer"] button')?.disabled).toBe(false);
    });
    expect(relationType.value).toBe('utkast till relation');
    chooseMenu(element, 'Skapa', 'Ärende');
    fixture.detectChanges();
    expect(admin.hidden).toBe(true);
    const caseSection = element.querySelector<HTMLElement>('section[aria-labelledby="case-title"]')!;
    expect(caseSection.querySelector('h3')?.textContent).toContain('Nytt ärende');
    expect(element.querySelectorAll('tbody tr')).toHaveLength(2);
    const sentence = caseSection.querySelector<HTMLInputElement>('input[name="caseSentence"]')!;
    sentence.value = 'Påbörjat ärende';
    sentence.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const createOption = [...element.querySelectorAll<HTMLButtonElement>('.menu-options button')]
      .find((button) => button.textContent?.trim() === 'Ärende')!;
    expect(createOption.disabled).toBe(true);
    chooseMenu(element, 'Skapa', 'Ärende');
    fixture.detectChanges();
    expect(sentence.value).toBe('Påbörjat ärende');
  });

  it('allows creating a case without granting administration access', async () => {
    const { fixture, element } = await workspace(false, false, records, [], undefined,
      ['read', 'case:create']);
    chooseMenu(element, 'Skapa', 'Ärende');
    fixture.detectChanges();
    expect(element.querySelector('section[aria-labelledby="case-title"] form')).not.toBeNull();
    const options = [...element.querySelectorAll<HTMLButtonElement>('.main-menu button')];
    expect(options.find((button) => button.textContent?.trim() === 'Hantera relationer')?.disabled).toBe(true);
    expect(options.find((button) => button.textContent?.trim() === 'Hantera Användare')?.disabled).toBe(true);
  });

  it('closes dropdowns on Escape and outside clicks', async () => {
    const { fixture, element } = await workspace();
    const menu = element.querySelector<HTMLDetailsElement>('.main-menu details')!;
    const summary = menu.querySelector<HTMLElement>('summary')!;
    summary.click();
    fixture.detectChanges();
    expect(menu.open).toBe(true);
    summary.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(menu.open).toBe(false);
    expect(document.activeElement).toBe(summary);
    summary.click();
    fixture.detectChanges();
    document.body.click();
    fixture.detectChanges();
    expect(menu.open).toBe(false);
  });

  it('uses sorted value lists for case fields and preserves invalid multivalues until removed', async () => {
    const lists = [
      { listName: 'explicit-class-list', value: 'Ö' },
      { listName: 'explicit-class-list', value: 'A' },
      { listName: 'extraClass', value: 'två' },
      { listName: 'extraClass', value: 'tre' },
      { listName: 'diaryNumber_ValueList', value: 'D-1' },
      { listName: 'caseSentence_ValueList', value: 'Ärenderubrik' },
    ];
    const { fixture, element } = await workspace(false, false, records, lists, {
      base_case: { classification: 'explicit-class-list', extraclass: 'extraClass' },
      base_record: { recordType: 'recordType' },
      base_document: { documentType: 'documentType' },
    });
    element.querySelector<HTMLButtonElement>('.result-link')?.click();
    fixture.detectChanges();
    const caseSection = element.querySelector<HTMLElement>('section[aria-labelledby="case-title"]')!;
    [...caseSection.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Ändra')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const classification = caseSection.querySelector<HTMLSelectElement>('select[name="classification"]')!;
    expect([...classification.options].map((option) => option.textContent?.trim()))
      .toEqual(['Välj värde', 'ABC (välj ett nytt värde)', 'A', 'Ö']);
    expect(classification.value).toBe('ABC');
    expect(caseSection.querySelector('input[name="diaryNumber"]')).not.toBeNull();
    expect(caseSection.querySelector('input[name="caseSentence"]')).not.toBeNull();
    expect(caseSection.textContent?.replace(/\s+/g, ' ')).toContain('ett (finns inte i listan)');
    classification.value = 'A';
    classification.dispatchEvent(new Event('change'));
    caseSection.querySelector<HTMLButtonElement>('button[aria-label="Ta bort ett"]')!.click();
    const extra = caseSection.querySelector<HTMLSelectElement>('select:not([name])')!;
    expect([...extra.options].map((option) => option.value)).toEqual(['', 'tre', 'två']);
    extra.value = 'två';
    extra.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    caseSection.querySelector('form')!.dispatchEvent(new Event('submit'));
    await vi.waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([url, options]) => url === '/api/cases/case-1' && options?.method === 'PUT');
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]?.body))).toMatchObject({ classification: 'A', extraclass: ['två'] });
    });
  });

  it('uses value lists in record editors and retains ordinary inputs for fields without lists', async () => {
    const lists = [
      { listName: 'name_ValueList', value: 'Handling ett' },
      { listName: 'description_ValueList', value: 'Beskrivning' },
      { listName: 'recordType', value: 'Övrigt' },
      { listName: 'recordType', value: 'Brev' },
    ];
    const { fixture, element } = await workspace(false, false, records, lists);
    element.querySelector<HTMLButtonElement>('.result-link')?.click();
    fixture.detectChanges();
    element.querySelector<HTMLButtonElement>('.record-toggle')!.click();
    fixture.detectChanges();
    [...element.querySelectorAll<HTMLButtonElement>('.record-content:not([hidden]) .button-secondary')]
      .find((button) => button.textContent?.trim() === 'Ändra')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(element.querySelector('input[name="name"]')).not.toBeNull();
    expect(element.querySelector('input[name="description"]')).not.toBeNull();
    const recordType = element.querySelector<HTMLSelectElement>('select[name="recordType"]')!;
    expect([...recordType.options].map((option) => option.value)).toEqual(['', 'Brev', 'Övrigt']);
    expect(recordType.value).toBe('Brev');
  });

  it('shows dropdowns for each explicitly bound value list', async () => {
    const lists = [
      { listName: 'classification', value: '2.3.4' },
      { listName: 'classification', value: '1.2.3' },
      { listName: 'extraClass', value: 'extraklass2' },
      { listName: 'extraClass', value: 'extraklass 1' },
      { listName: 'recordType', value: 'FrågaSvar' },
      { listName: 'recordType', value: 'BESTÄLLNING' },
    ];
    const { fixture, element } = await workspace(false, false, records, lists);
    element.querySelector<HTMLButtonElement>('.result-link')!.click();
    fixture.detectChanges();
    const caseSection = element.querySelector<HTMLElement>('section[aria-labelledby="case-title"]')!;
    [...caseSection.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Ändra')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const classification = caseSection.querySelector<HTMLSelectElement>('select[name="classification"]')!;
    expect([...classification.options].map((option) => option.value)).toEqual(['', 'ABC', '1.2.3', '2.3.4']);
    const extraClass = caseSection.querySelector<HTMLSelectElement>('select:not([name])')!;
    expect([...extraClass.options].map((option) => option.value)).toEqual(['', 'extraklass 1', 'extraklass2']);
    [...caseSection.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Avbryt')!.click();
    fixture.detectChanges();
    element.querySelector<HTMLButtonElement>('section[aria-labelledby="record-title"] .button-primary')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const recordType = element.querySelector<HTMLSelectElement>('select[name="recordType"]')!;
    expect([...recordType.options].map((option) => option.value)).toEqual(['', 'BESTÄLLNING', 'FrågaSvar']);
  });

  it('saves an edited record and returns to read-only view', async () => {
    const { fixture, element } = await workspace();
    element.querySelector<HTMLButtonElement>('.result-link')?.click();
    fixture.detectChanges();
    const recordSection = element.querySelector<HTMLElement>('section[aria-labelledby="record-title"]')!;
    const toggles = [...recordSection.querySelectorAll<HTMLButtonElement>('.record-toggle')];
    toggles[0].click();
    fixture.detectChanges();
    toggles[1].click();
    fixture.detectChanges();
    const firstContent = recordSection.querySelector<HTMLElement>('.record-content:not([hidden])')!;
    const edit = [...firstContent.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Ändra');
    edit?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const name = recordSection.querySelector<HTMLInputElement>('input[name="name"]')!;
    name.value = 'Ändrad handling';
    name.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    recordSection.querySelector('form')?.dispatchEvent(new Event('submit'));
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(toggles[0].textContent).toContain('Ändrad handling');
      expect(toggles.map((button) => button.getAttribute('aria-expanded'))).toEqual(['true', 'true']);
      expect(recordSection.querySelector('input')).toBeNull();
    });
  });
});
