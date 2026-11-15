import { afterNextRender, Component, computed, HostListener, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';

interface BaseObject {
  objectId: string;
  objectType: 'base_case' | 'base_record';
  created: string;
  createdBy: string;
  lastUpdated: string;
  lastUpdatedBy: string;
}

interface Case extends BaseObject {
  diaryNumber: string;
  classification: string;
  extraclass: string[];
  caseSentence: string;
}

interface RecordItem extends BaseObject {
  caseId: string;
  name: string;
  description: string;
  recordType: string;
}

interface DocumentItem {
  objectId: string;
  recordId: string;
  name: string;
  documentType: string;
  filetype: string;
  filesize: number;
  filename: string;
  originalFilename: string | null;
}

interface Relation {
  id: string;
  sourceId: string;
  targetId: string;
  objectTypes: string;
  relationType: string;
  automatic: boolean;
}

interface SearchResult {
  objectId: string;
  objectType: 'base_case' | 'base_record' | 'base_document';
  created: string;
  createdBy: string;
  diaryNumber: string | null;
  caseSentence: string | null;
  name: string | null;
  recordType: string | null;
  recordId: string | null;
  documentType: string | null;
  filetype: string | null;
  filesize: number | null;
  filename: string | null;
  originalFilename: string | null;
}

interface LoginResponse {
  token: string;
  username: string;
}

interface ValueListEntry {
  listName: string;
  value: string;
}

interface ValueListBindings {
  base_case: { classification: string; extraclass: string };
  base_record: { recordType: string };
  base_document: { documentType: string };
}

interface CurrentUser {
  username: string;
  roles: string[];
  permissions: string[];
  supportedUserRoles: string[];
}

interface ValueListElement {
  objectId: string;
  value: string;
  supported: boolean;
}

interface ValueListDefinition {
  objectId: string;
  listName: string;
  listDescription: string;
  boundFields: string[];
  maxValueLength: number;
  values: ValueListElement[];
}

interface ManagedUser {
  id: string;
  username: string;
  roles: string[];
}

type FormMode = 'view' | 'create' | 'edit';
type Menu = 'search' | 'create' | 'admin';
type AdminPanel = 'users' | 'relations' | 'valueLists' | null;

@Component({
  imports: [FormsModule, NgTemplateOutlet],
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {
  protected readonly username = signal('');
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly cases = signal<Case[]>([]);
  protected readonly records = signal<RecordItem[]>([]);
  protected readonly documents = signal<DocumentItem[]>([]);
  protected readonly relations = signal<Relation[]>([]);
  protected readonly valueLists = signal<Record<string, string[]>>({});
  protected readonly availableRoles = signal<string[]>([]);
  protected readonly supportedUserRoles = signal<string[]>([]);
  protected readonly permissions = signal<string[]>([]);
  protected readonly userMessage = signal('');
  protected readonly relationMessage = signal('');
  protected readonly users = signal<ManagedUser[]>([]);
  protected readonly usersLoaded = signal(false);
  protected readonly listDefinitions = signal<ValueListDefinition[]>([]);
  protected readonly listDefinitionsLoaded = signal(false);
  protected readonly valueListMessage = signal('');
  protected readonly results = signal<SearchResult[]>([]);
  protected readonly searched = signal(false);
  protected readonly selectedCaseId = signal('');
  protected readonly openRecordIds = signal<Set<string>>(new Set());
  protected readonly selectedCase = computed(() => this.cases().find((item) => item.objectId === this.selectedCaseId()));
  protected readonly caseRecords = computed(() => {
    const caseId = this.selectedCaseId();
    if (!caseId) return [];
    const relatedIds = new Set(this.relations()
      .filter((relation) => !relation.automatic && relation.sourceId === caseId)
      .map((relation) => relation.targetId));
    return this.records()
      .filter((item) => item.caseId === caseId || relatedIds.has(item.objectId))
      .sort((a, b) => a.created.localeCompare(b.created));
  });
  protected loginUsername = '';
  protected password = '';
  protected searchQuery = '';
  protected caseMode: FormMode = 'view';
  protected recordMode: FormMode = 'view';
  protected editingRecordId = '';
  protected caseForm = this.emptyCase();
  protected caseExtraValues: string[] = [];
  protected recordForm = this.emptyRecord();
  protected documentRecordId = '';
  protected documentName = '';
  protected documentType = '';
  protected documentFile: File | null = null;
  protected documentFileError = '';
  protected documentDragging = false;
  protected documentMenu: { item: DocumentItem; x: number; y: number } | null = null;
  protected editingDocument: DocumentItem | null = null;
  protected editingDocumentName = '';
  protected relationForm = { sourceId: '', targetId: '', relationType: '' };
  protected selectedRelation: Relation | null = null;
  protected newUsername = '';
  protected newPassword = '';
  protected newUserRoles: string[] = [];
  protected selectedUser: ManagedUser | null = null;
  protected selectedValueList: ValueListDefinition | null = null;
  protected listName = '';
  protected listDescription = '';
  protected listValue = '';
  protected openMenu: Menu | null = null;
  protected adminPanel: AdminPanel = null;
  private lastSearchQuery = '';
  private token = '';

  constructor() {
    afterNextRender(() => {
      this.token = sessionStorage.getItem('cassisToken') || '';
      this.username.set(sessionStorage.getItem('cassisUsername') || '');
      if (this.token && this.username()) void this.run(() => this.refresh());
    });
  }

  protected get editing(): boolean {
    return this.caseMode !== 'view' || this.recordMode !== 'view' || Boolean(this.documentRecordId || this.editingDocument);
  }

  protected toggleMenu(menu: Menu): void {
    this.openMenu = this.openMenu === menu ? null : menu;
  }

  @HostListener('document:click')
  protected closeMenu(): void {
    this.openMenu = null;
    this.documentMenu = null;
  }

  @HostListener('document:keydown.escape')
  protected closeDocumentMenu(): void {
    this.documentMenu = null;
  }

  protected menuFocusOut(event: FocusEvent): void {
    if (!(event.currentTarget instanceof HTMLElement) ||
        !(event.relatedTarget instanceof Node) ||
        !event.currentTarget.contains(event.relatedTarget)) {
      this.closeMenu();
    }
  }

  protected menuEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !this.openMenu) return;
    event.preventDefault();
    const menu = (event.target as HTMLElement).closest('details');
    this.closeMenu();
    menu?.querySelector('summary')?.focus();
  }

  protected showSearch(input: HTMLInputElement): void {
    this.adminPanel = null;
    this.closeMenu();
    input.focus();
  }

  protected showAdmin(panel: Exclude<AdminPanel, null>): void {
    if (panel === 'users' && this.adminPanel !== 'users') void this.run(() => this.loadUsers());
    if (panel === 'relations' && this.adminPanel !== 'relations') {
      void this.run(async () => this.setRelations(await this.request<Relation[]>('/relations')));
    }
    if (panel === 'valueLists' && this.adminPanel !== 'valueLists') void this.run(() => this.loadValueListDefinitions());
    this.adminPanel = panel;
    this.closeMenu();
  }

  protected createCaseFromMenu(heading: HTMLElement): void {
    if (!this.can('case:create') || this.busy() || this.editing) return;
    this.adminPanel = null;
    this.closeMenu();
    this.newCase();
    heading.focus();
  }

  private emptyCase() {
    return { diaryNumber: '', classification: '', extraclass: '', caseSentence: '' };
  }

  private emptyRecord() {
    return { caseId: '', name: '', description: '', recordType: '' };
  }

  private async request<T>(path: string, method = 'GET', body?: object): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const formData = body instanceof FormData;
    if (body && !formData) headers['Content-Type'] = 'application/json';
    const response = await fetch(`/api${path}`, {
      method,
      headers,
      body: body ? formData ? body : JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      if (response.status === 401 && path !== '/auth/login') this.clearSession();
      const payload: { error?: string } = await response.json();
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  protected async run(action: () => Promise<void>): Promise<void> {
    this.error.set('');
    this.busy.set(true);
    try {
      await action();
    } catch (error) {
      console.error('Request failed:', error);
      this.error.set(error instanceof Error ? error.message : 'Ett oväntat fel inträffade.');
    } finally {
      this.busy.set(false);
    }
  }

  protected async login(): Promise<void> {
    await this.run(async () => {
      const result = await this.request<LoginResponse>('/auth/login', 'POST', {
        username: this.loginUsername,
        password: this.password,
      });
      this.password = '';
      this.token = result.token;
      this.username.set(result.username);
      sessionStorage.setItem('cassisToken', this.token);
      sessionStorage.setItem('cassisUsername', result.username);
      await this.refresh();
    });
  }

  protected async logout(): Promise<void> {
    if ((this.editing || this.userDraftChanged || this.relationDraftChanged || this.valueListDraftChanged)
      && !confirm('Logga ut och kasta osparade ändringar?')) return;
    await this.run(async () => {
      await this.request<void>('/auth/logout', 'POST');
      this.clearSession();
    });
  }

  private clearSession(): void {
    this.token = '';
    this.username.set('');
    sessionStorage.removeItem('cassisToken');
    sessionStorage.removeItem('cassisUsername');
    this.cases.set([]);
    this.records.set([]);
    this.documents.set([]);
    this.relations.set([]);
    this.valueLists.set({});
    this.availableRoles.set([]);
    this.supportedUserRoles.set([]);
    this.permissions.set([]);
    this.userMessage.set('');
    this.relationMessage.set('');
    this.users.set([]);
    this.usersLoaded.set(false);
    this.listDefinitions.set([]);
    this.listDefinitionsLoaded.set(false);
    this.valueListMessage.set('');
    this.results.set([]);
    this.searched.set(false);
    this.selectedCaseId.set('');
    this.openRecordIds.set(new Set());
    this.caseMode = 'view';
    this.recordMode = 'view';
    this.editingRecordId = '';
    this.caseForm = this.emptyCase();
    this.caseExtraValues = [];
    this.recordForm = this.emptyRecord();
    this.cancelDocument();
    this.editingDocument = null;
    this.editingDocumentName = '';
    this.documentMenu = null;
    this.relationForm = { sourceId: '', targetId: '', relationType: '' };
    this.selectedRelation = null;
    this.searchQuery = '';
    this.lastSearchQuery = '';
    this.newUsername = '';
    this.newPassword = '';
    this.newUserRoles = [];
    this.selectedUser = null;
    this.selectedValueList = null;
    this.listName = '';
    this.listDescription = '';
    this.listValue = '';
    this.openMenu = null;
    this.adminPanel = null;
  }

  private async refresh(): Promise<void> {
    const previousRecordCount = this.caseRecords().length;
    const [cases, records, documents, relations, valueListEntries, bindings, currentUser] = await Promise.all([
      this.request<Case[]>('/cases'),
      this.request<RecordItem[]>('/records'),
      this.request<DocumentItem[]>('/documents'),
      this.request<Relation[]>('/relations'),
      this.request<ValueListEntry[]>('/value-lists'),
      this.request<ValueListBindings>('/value-list-bindings'),
      this.request<CurrentUser>('/me'),
    ]);
    const listsByName: Record<string, string[]> = Object.create(null);
    for (const entry of valueListEntries) {
      (listsByName[entry.listName] ||= []).push(entry.value);
    }
    const valueLists: Record<string, string[]> = Object.create(null);
    for (const [field, listName] of Object.entries({ ...bindings.base_case, ...bindings.base_record, ...bindings.base_document })) {
      if (listsByName[listName]) valueLists[field] = listsByName[listName];
    }
    for (const values of Object.values(valueLists)) values.sort((a, b) => a.localeCompare(b, 'sv'));
    if (this.caseMode !== 'view' && Boolean(this.valueLists()['extraclass']) !== Boolean(valueLists['extraclass'])) {
      if (valueLists['extraclass']) {
        this.caseExtraValues = this.caseForm.extraclass.split('\n').map((value) => value.trim()).filter(Boolean);
      } else {
        this.caseForm.extraclass = this.caseExtraValues.join('\n');
      }
    }
    this.cases.set(cases);
    this.records.set(records);
    this.documents.set(documents);
    this.setRelations(relations, previousRecordCount);
    this.valueLists.set(valueLists);
    this.availableRoles.set((listsByName['userRole'] || []).sort((a, b) => a.localeCompare(b, 'sv')));
    this.permissions.set(currentUser.permissions);
    this.supportedUserRoles.set(currentUser.supportedUserRoles);
    this.username.set(currentUser.username);
    sessionStorage.setItem('cassisUsername', currentUser.username);
  }

  private setRelations(relations: Relation[], previousRecordCount = this.caseRecords().length): void {
    this.relations.set(relations);
    if (!this.selectedCaseId()) return;
    const records = this.caseRecords();
    const visibleIds = new Set(records.map((record) => record.objectId));
    const openIds = new Set([...this.openRecordIds()].filter((id) => visibleIds.has(id)));
    if (previousRecordCount !== 1 && records.length === 1) openIds.add(records[0].objectId);
    this.openRecordIds.set(openIds);
  }

  protected can(permission: string): boolean {
    return this.permissions().includes(permission);
  }

  protected toggleUserRole(role: string, selected: boolean): void {
    this.newUserRoles = selected ? [...this.newUserRoles, role] : this.newUserRoles.filter((value) => value !== role);
  }

  private get valueListDraftChanged(): boolean {
    return this.selectedValueList
      ? this.listDescription !== this.selectedValueList.listDescription || Boolean(this.listValue)
      : Boolean(this.listName || this.listDescription);
  }

  private async loadValueListDefinitions(): Promise<void> {
    const definitions = await this.request<ValueListDefinition[]>('/value-list-definitions');
    this.listDefinitions.set(definitions);
    this.listDefinitionsLoaded.set(true);
    if (this.selectedValueList) {
      const current = definitions.find((list) => list.objectId === this.selectedValueList!.objectId);
      if (current) {
        const hasDraft = this.valueListDraftChanged;
        const description = hasDraft ? this.selectedValueList.listDescription : current.listDescription;
        this.selectedValueList = { ...current, listDescription: description };
        if (!hasDraft) this.listDescription = current.listDescription;
      }
    }
  }

  protected selectValueList(list: ValueListDefinition): void {
    if (this.selectedValueList?.objectId === list.objectId) return;
    if (this.valueListDraftChanged && !confirm('Kasta osparade ändringar i värdelistan?')) return;
    this.selectedValueList = list;
    this.listName = list.listName;
    this.listDescription = list.listDescription;
    this.listValue = '';
    this.valueListMessage.set('');
  }

  protected newValueList(): void {
    if (this.valueListDraftChanged && !confirm('Kasta osparade ändringar i värdelistan?')) return;
    this.selectedValueList = null;
    this.listName = '';
    this.listDescription = '';
    this.listValue = '';
    this.valueListMessage.set('');
  }

  protected async saveValueList(): Promise<void> {
    this.valueListMessage.set('');
    await this.run(async () => {
      if (this.selectedValueList) {
        const updated = await this.request<{ objectId: string; listDescription: string }>(
          `/value-list-definitions/${this.selectedValueList.objectId}`, 'PUT', { listDescription: this.listDescription });
        this.selectedValueList = { ...this.selectedValueList, listDescription: updated.listDescription };
        this.listDefinitions.set(this.listDefinitions().map((list) =>
          list.objectId === updated.objectId ? { ...list, listDescription: updated.listDescription } : list));
        this.valueListMessage.set('Beskrivningen har sparats.');
      } else {
        const list = await this.request<ValueListDefinition>('/value-list-definitions', 'POST',
          { listName: this.listName, listDescription: this.listDescription });
        this.listDefinitions.set([...this.listDefinitions(), list].sort((a, b) => a.listName.localeCompare(b.listName, 'sv')));
        this.selectedValueList = list;
        this.listName = list.listName;
        this.listDescription = list.listDescription;
        this.valueListMessage.set('Värdelistan har skapats.');
      }
    });
  }

  protected async addListValue(): Promise<void> {
    const list = this.selectedValueList;
    if (!list) return;
    const fieldsWithFreeText = list.boundFields.filter((field) => field !== 'base_document.documentType');
    if (!list.values.length && fieldsWithFreeText.length &&
        !confirm(`Listan används av ${fieldsWithFreeText.join(', ')}. Det första värdet aktiverar validering och befintliga värden utanför listan måste ändras innan objekten kan sparas. Fortsätta?`)) return;
    this.valueListMessage.set('');
    await this.run(async () => {
      const value = await this.request<ValueListElement>(`/value-list-definitions/${list.objectId}/values`, 'POST', { value: this.listValue });
      const updated = { ...list, values: [...list.values, value].sort((a, b) => a.value.localeCompare(b.value, 'sv')) };
      this.selectedValueList = updated;
      this.listDefinitions.set(this.listDefinitions().map((entry) => entry.objectId === list.objectId ? updated : entry));
      this.listValue = '';
      this.valueListMessage.set(value.supported ? 'Värdet har lagts till.' : 'Värdet har lagts till, men rollen kan inte användas förrän rättigheter har definierats.');
      await this.refresh();
    });
  }

  private async loadUsers(): Promise<void> {
    this.users.set((await this.request<ManagedUser[]>('/users')).sort((a, b) => a.username.localeCompare(b.username, 'sv')));
    this.usersLoaded.set(true);
  }

  private get userDraftChanged(): boolean {
    if (!this.selectedUser) return Boolean(this.newUsername || this.newPassword || this.newUserRoles.length);
    return this.newUsername !== this.selectedUser.username || Boolean(this.newPassword)
      || this.newUserRoles.length !== this.selectedUser.roles.length
      || this.newUserRoles.some((role) => !this.selectedUser!.roles.includes(role));
  }

  protected selectUser(user: ManagedUser): void {
    if (this.selectedUser?.id === user.id) return;
    if (this.userDraftChanged && !confirm('Kasta osparade ändringar i användarformuläret?')) return;
    this.selectedUser = user;
    this.newUsername = user.username;
    this.newPassword = '';
    this.newUserRoles = [...user.roles];
    this.userMessage.set('');
  }

  protected newUser(): void {
    if (this.userDraftChanged && !confirm('Kasta osparade ändringar i användarformuläret?')) return;
    this.resetUserForm();
    this.userMessage.set('');
  }

  private resetUserForm(): void {
    this.selectedUser = null;
    this.newUsername = '';
    this.newPassword = '';
    this.newUserRoles = [];
  }

  protected async saveUser(): Promise<void> {
    this.userMessage.set('');
    await this.run(async () => {
      const previous = this.selectedUser;
      const body = {
        username: this.newUsername.trim(),
        roles: this.newUserRoles,
        ...(this.newPassword ? { password: this.newPassword } : {}),
      };
      const user = await this.request<ManagedUser>(previous ? `/users/${previous.id}` : '/users', previous ? 'PUT' : 'POST', body);
      this.newPassword = '';
      this.users.set([...this.users().filter((item) => item.id !== user.id), user]
        .sort((a, b) => a.username.localeCompare(b.username, 'sv')));
      if (previous) {
        this.selectedUser = user;
        this.newUsername = user.username;
        this.newUserRoles = [...user.roles];
      } else {
        this.resetUserForm();
      }
      this.userMessage.set(`Användaren ${user.username} har ${previous ? 'ändrats' : 'skapats'}.`);
      if (previous?.username === this.username()) {
        const current = await this.request<CurrentUser>('/me');
        this.username.set(current.username);
        sessionStorage.setItem('cassisUsername', current.username);
        this.permissions.set(current.permissions);
        this.supportedUserRoles.set(current.supportedUserRoles);
        if (!this.can('user:create')) {
          this.adminPanel = null;
          this.users.set([]);
          this.resetUserForm();
        }
      }
    });
  }

  protected async deleteUser(): Promise<void> {
    const user = this.selectedUser;
    if (!user || !confirm(`Ta bort användaren ${user.username}?`)) return;
    await this.run(async () => {
      await this.request<void>(`/users/${user.id}`, 'DELETE');
      this.users.set(this.users().filter((item) => item.id !== user.id));
      this.resetUserForm();
      this.userMessage.set(`Användaren ${user.username} har tagits bort.`);
    });
  }

  private async refreshSearch(): Promise<void> {
    if (this.searched()) {
      this.results.set(await this.request<SearchResult[]>(`/search?q=${encodeURIComponent(this.lastSearchQuery)}`));
    }
  }

  protected selectResult(result: SearchResult): void {
    this.error.set('');
    if (result.objectType === 'base_case') {
      const item = this.cases().find((entry) => entry.objectId === result.objectId);
      if (item) {
        this.selectCase(item);
        return;
      }
    } else if (result.objectType === 'base_record') {
      const item = this.records().find((entry) => entry.objectId === result.objectId);
      if (item && this.cases().some((entry) => entry.objectId === item.caseId)) {
        this.selectRecord(item);
        return;
      }
    } else if (result.objectType === 'base_document') {
      const document = this.documents().find((entry) => entry.objectId === result.objectId);
      const item = this.records().find((entry) => entry.objectId === document?.recordId);
      if (item && this.cases().some((entry) => entry.objectId === item.caseId)) {
        this.selectRecord(item);
        return;
      }
    }
    this.error.set('Objektet eller dess ärende kunde inte hittas. Sök igen för att uppdatera listan.');
  }

  protected selectCase(item: Case): void {
    this.selectedCaseId.set(item.objectId);
    const records = this.caseRecords();
    this.openRecordIds.set(new Set(records.length === 1 ? [records[0].objectId] : []));
  }

  protected selectRecord(item: RecordItem): void {
    const openIds = this.selectedCaseId() === item.caseId ? new Set(this.openRecordIds()) : new Set<string>();
    openIds.add(item.objectId);
    this.selectedCaseId.set(item.caseId);
    this.openRecordIds.set(openIds);
  }

  protected toggleRecord(item: RecordItem): void {
    const openIds = new Set(this.openRecordIds());
    if (openIds.has(item.objectId)) {
      openIds.delete(item.objectId);
    } else {
      openIds.add(item.objectId);
    }
    this.openRecordIds.set(openIds);
  }

  protected newCase(): void {
    this.caseForm = this.emptyCase();
    this.caseExtraValues = [];
    this.caseMode = 'create';
  }

  protected editCase(item: Case): void {
    this.caseForm = {
      diaryNumber: item.diaryNumber,
      classification: item.classification,
      caseSentence: item.caseSentence,
      extraclass: item.extraclass.join('\n'),
    };
    this.caseExtraValues = [...item.extraclass];
    this.caseMode = 'edit';
  }

  protected addExtraClass(select: HTMLSelectElement): void {
    if (select.value) this.caseExtraValues.push(select.value);
    select.value = '';
  }

  protected removeExtraClass(index: number): void {
    this.caseExtraValues.splice(index, 1);
  }

  protected cancelCase(): void {
    this.caseMode = 'view';
    this.caseForm = this.emptyCase();
    this.caseExtraValues = [];
  }

  protected async saveCase(): Promise<void> {
    await this.run(async () => {
      const body = {
        ...this.caseForm,
        extraclass: this.valueLists()['extraclass']
          ? this.caseExtraValues
          : this.caseForm.extraclass.split('\n').map((value) => value.trim()).filter(Boolean),
      };
      const item = await this.request<Case>(this.caseMode === 'edit' ? `/cases/${this.selectedCaseId()}` : '/cases',
        this.caseMode === 'edit' ? 'PUT' : 'POST', body);
      const creating = this.caseMode === 'create';
      this.cancelCase();
      await this.refresh();
      if (creating) {
        this.selectedCaseId.set(item.objectId);
        this.openRecordIds.set(new Set());
      }
      await this.refreshSearch();
    });
  }

  protected async deleteCase(item: Case): Promise<void> {
    if (!confirm('Ta bort ärendet och de handlingar som tillhör det? Manuellt kopplade handlingar från andra ärenden tas inte bort.')) return;
    await this.run(async () => {
      await this.request(`/cases/${item.objectId}`, 'DELETE');
      this.selectedCaseId.set('');
      this.openRecordIds.set(new Set());
      await this.refresh();
      await this.refreshSearch();
    });
  }

  protected newRecord(): void {
    this.recordForm = { ...this.emptyRecord(), caseId: this.selectedCaseId() };
    this.recordMode = 'create';
  }

  protected editRecord(item: RecordItem): void {
    this.recordForm = { caseId: item.caseId, name: item.name, description: item.description, recordType: item.recordType };
    this.editingRecordId = item.objectId;
    this.recordMode = 'edit';
  }

  protected cancelRecord(): void {
    this.recordMode = 'view';
    this.editingRecordId = '';
    this.recordForm = this.emptyRecord();
  }

  protected async saveRecord(): Promise<void> {
    await this.run(async () => {
      const editing = this.recordMode === 'edit';
      const item = await this.request<RecordItem>(this.recordMode === 'edit' ? `/records/${this.editingRecordId}` : '/records',
        this.recordMode === 'edit' ? 'PUT' : 'POST', this.recordForm);
      this.cancelRecord();
      await this.refresh();
      if (editing && this.caseRecords().some((record) => record.objectId === item.objectId)) {
        this.openRecordIds.set(new Set([...this.openRecordIds(), item.objectId]));
      } else {
        this.selectRecord(item);
      }
      await this.refreshSearch();
    });
  }

  protected async deleteRecord(item: RecordItem): Promise<void> {
    if (!confirm('Ta bort handlingen? Den tas även bort från andra ärenden där den är kopplad.')) return;
    await this.run(async () => {
      await this.request(`/records/${item.objectId}`, 'DELETE');
      const openIds = new Set(this.openRecordIds());
      openIds.delete(item.objectId);
      this.openRecordIds.set(openIds);
      await this.refresh();
      await this.refreshSearch();
    });
  }

  protected documentsFor(recordId: string): DocumentItem[] {
    return this.documents().filter((document) => document.recordId === recordId);
  }

  protected showDocumentMenu(event: MouseEvent, item: DocumentItem): void {
    event.preventDefault();
    event.stopPropagation();
    if (this.busy() || this.editing) return;
    const target = event.currentTarget;
    const rect = target instanceof HTMLElement ? target.getBoundingClientRect() : null;
    const x = event.clientX || rect?.left || 0;
    const y = event.clientY || rect?.bottom || 0;
    this.documentMenu = {
      item,
      x: Math.max(0, Math.min(x, window.innerWidth - 210)),
      y: Math.max(0, Math.min(y, window.innerHeight - 190)),
    };
    setTimeout(() => document.querySelector<HTMLButtonElement>('.document-menu button:not(:disabled)')?.focus());
  }

  protected documentMenuKeydown(event: KeyboardEvent): void {
    if (!(event.currentTarget instanceof HTMLElement)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.parentElement?.querySelector<HTMLButtonElement>('.document-menu-trigger')?.focus();
      this.documentMenu = null;
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (!buttons.length) return;
    const index = buttons.findIndex((button) => button === document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : event.key === 'ArrowDown' ? (index + 1) % buttons.length : (index - 1 + buttons.length) % buttons.length;
    buttons[next].focus();
  }

  protected editDocument(item: DocumentItem): void {
    this.documentMenu = null;
    this.editingDocument = item;
    this.editingDocumentName = item.name;
  }

  protected cancelDocumentEdit(): void {
    this.editingDocument = null;
    this.editingDocumentName = '';
  }

  protected async saveDocumentEdit(): Promise<void> {
    const item = this.editingDocument;
    if (!item) return;
    await this.run(async () => {
      const updated = await this.request<{ objectId: string; name: string }>(`/documents/${item.objectId}`, 'PUT',
        { name: this.editingDocumentName });
      this.documents.update((documents) => documents.map((document) =>
        document.objectId === updated.objectId ? { ...document, name: updated.name } : document));
      this.cancelDocumentEdit();
      await this.refreshSearch();
    });
  }

  protected openDocument(item: DocumentItem): void {
    this.documentMenu = null;
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = `/api/documents/${encodeURIComponent(item.objectId)}/open`;
    form.target = '_blank';
    form.rel = 'noopener noreferrer';
    const token = document.createElement('input');
    token.type = 'hidden';
    token.name = 'token';
    token.value = this.token;
    form.appendChild(token);
    document.body.appendChild(form);
    try {
      form.submit();
    } finally {
      form.remove();
    }
  }

  protected async downloadDocument(item: DocumentItem): Promise<void> {
    this.documentMenu = null;
    await this.run(async () => {
      const response = await fetch(`/api/documents/${encodeURIComponent(item.objectId)}/content`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      if (!response.ok) {
        if (response.status === 401) this.clearSession();
        const payload: { error?: string } = await response.json();
        throw new Error(payload.error || `HTTP ${response.status}`);
      }
      const name = item.originalFilename || this.legacyDocumentFilename(item);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    });
  }

  private legacyDocumentFilename(item: DocumentItem): string {
    const name = item.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'dokument';
    return name.toLowerCase().endsWith(`.${item.filetype.toLowerCase()}`) ? name : `${name}.${item.filetype}`;
  }

  protected async deleteDocument(item: DocumentItem): Promise<void> {
    this.documentMenu = null;
    if (!confirm(`Ta bort dokumentet ${item.name}? Filen tas också bort.`)) return;
    await this.run(async () => {
      await this.request(`/documents/${item.objectId}`, 'DELETE');
      this.documents.update((documents) => documents.filter((document) => document.objectId !== item.objectId));
      await this.refreshSearch();
    });
  }

  protected importDocument(item: RecordItem): void {
    this.documentRecordId = item.objectId;
    this.documentName = '';
    this.documentType = '';
    this.documentFile = null;
    this.documentFileError = '';
    this.documentDragging = false;
  }

  protected selectDocumentFile(input: HTMLInputElement): void {
    this.setDocumentFiles(Array.from(input.files ?? []), input);
  }

  protected dragOverDocument(event: DragEvent): void {
    event.preventDefault();
    if (!this.busy()) this.documentDragging = true;
  }

  protected dragLeaveDocument(event: DragEvent): void {
    if (event.currentTarget instanceof HTMLElement && event.relatedTarget instanceof Node
        && event.currentTarget.contains(event.relatedTarget)) return;
    this.documentDragging = false;
  }

  protected dropDocument(event: DragEvent, input: HTMLInputElement): void {
    event.preventDefault();
    this.documentDragging = false;
    if (this.busy()) return;
    input.value = '';
    this.setDocumentFiles(Array.from(event.dataTransfer?.files ?? []), input);
  }

  private setDocumentFiles(files: File[], input: HTMLInputElement): void {
    this.documentFile = null;
    this.documentFileError = '';
    if (!files.length) {
      input.value = '';
      this.documentFileError = 'Välj eller släpp en fil.';
    } else if (files.length > 1) {
      input.value = '';
      this.documentFileError = 'Välj bara en fil åt gången.';
    } else if (!/\.(pdf|docx|xlsx|png|jpg)$/i.test(files[0].name)) {
      input.value = '';
      this.documentFileError = 'Filtypen stöds inte. Välj PDF, DOCX, XLSX, PNG eller JPG.';
    } else if (files[0].size > 25 * 1024 * 1024) {
      input.value = '';
      this.documentFileError = 'Filen får vara högst 25 MiB.';
    } else {
      this.documentFile = files[0];
    }
  }

  protected cancelDocument(): void {
    this.documentRecordId = '';
    this.documentName = '';
    this.documentType = '';
    this.documentFile = null;
    this.documentFileError = '';
    this.documentDragging = false;
  }

  protected async saveDocument(): Promise<void> {
    const file = this.documentFile;
    if (!file || !this.documentRecordId) return;
    await this.run(async () => {
      if (file.size > 25 * 1024 * 1024) throw new Error('Filen får vara högst 25 MiB.');
      const body = new FormData();
      body.append('file', file);
      body.append('name', this.documentName);
      body.append('documentType', this.documentType);
      const document = await this.request<DocumentItem>(`/records/${this.documentRecordId}/documents`, 'POST', body);
      this.documents.update((documents) => [document, ...documents]);
      this.cancelDocument();
      await this.refreshSearch();
    });
  }

  private get relationDraftChanged(): boolean {
    if (!this.selectedRelation) return Boolean(this.relationForm.sourceId || this.relationForm.targetId || this.relationForm.relationType);
    return this.relationForm.sourceId !== this.selectedRelation.sourceId
      || this.relationForm.targetId !== this.selectedRelation.targetId
      || this.relationForm.relationType !== this.selectedRelation.relationType;
  }

  protected selectRelation(relation: Relation): void {
    if (this.selectedRelation?.id === relation.id) return;
    if (this.relationDraftChanged && !confirm('Kasta osparade ändringar i relationsformuläret?')) return;
    this.selectedRelation = relation;
    this.relationForm = { sourceId: relation.sourceId, targetId: relation.targetId, relationType: relation.relationType };
    this.relationMessage.set('');
  }

  protected newRelation(): void {
    if (this.relationDraftChanged && !confirm('Kasta osparade ändringar i relationsformuläret?')) return;
    this.resetRelationForm();
    this.relationMessage.set('');
  }

  private resetRelationForm(): void {
    this.selectedRelation = null;
    this.relationForm = { sourceId: '', targetId: '', relationType: '' };
  }

  protected knownObject(objectId: string): boolean {
    return this.cases().some((item) => item.objectId === objectId)
      || this.records().some((item) => item.objectId === objectId);
  }

  protected manualCaseRelations(item: RecordItem): Relation[] {
    return this.relations().filter((relation) =>
      !relation.automatic && relation.sourceId === this.selectedCaseId() && relation.targetId === item.objectId);
  }

  protected recordCaseNumber(item: RecordItem): string {
    return this.cases().find((caseItem) => caseItem.objectId === item.caseId)?.diaryNumber || '—';
  }

  protected async unlinkRecord(relation: Relation): Promise<void> {
    if (this.editing || relation.automatic) return;
    const editingRelation = this.selectedRelation?.id === relation.id && this.relationDraftChanged;
    const message = editingRelation
      ? 'Ta bort kopplingen och kasta osparade ändringar i relationsformuläret?'
      : 'Ta bort kopplingen? Handlingen finns kvar i sitt ursprungliga ärende.';
    if (!confirm(message)) return;
    await this.run(async () => {
      await this.request<void>(`/relations/${relation.id}`, 'DELETE');
      this.setRelations(this.relations().filter((item) => item.id !== relation.id));
      if (this.selectedRelation?.id === relation.id) this.resetRelationForm();
    });
  }

  protected async saveRelation(): Promise<void> {
    if (this.editing || this.selectedRelation?.automatic) return;
    this.relationMessage.set('');
    await this.run(async () => {
      const previous = this.selectedRelation;
      const relation = await this.request<Relation>(previous ? `/relations/${previous.id}` : '/relations',
        previous ? 'PUT' : 'POST', this.relationForm);
      this.setRelations([...this.relations().filter((item) => item.id !== relation.id), relation]);
      if (previous) {
        this.selectedRelation = relation;
        this.relationForm = { sourceId: relation.sourceId, targetId: relation.targetId, relationType: relation.relationType };
      } else {
        this.resetRelationForm();
      }
      this.relationMessage.set(`Relationen har ${previous ? 'ändrats' : 'skapats'}.`);
    });
  }

  protected async deleteRelation(): Promise<void> {
    const relation = this.selectedRelation;
    if (!relation || relation.automatic || this.editing) return;
    if (!confirm('Ta bort relationen?')) return;
    await this.run(async () => {
      await this.request(`/relations/${relation.id}`, 'DELETE');
      this.setRelations(this.relations().filter((item) => item.id !== relation.id));
      this.resetRelationForm();
      this.relationMessage.set('Relationen har tagits bort.');
    });
  }

  protected objectLabel(objectId: string): string {
    const item = this.cases().find((entry) => entry.objectId === objectId);
    if (item) {
      const name = [item.diaryNumber, item.caseSentence].filter(Boolean).join(' — ');
      return `base_case: ${name || '(utan diarienummer och rubrik)'}`;
    }
    const record = this.records().find((entry) => entry.objectId === objectId);
    return record ? `base_record: ${record.name || '(utan namn)'}` : 'Okänt objekt (kan ha tagits bort)';
  }

  protected async search(): Promise<void> {
    await this.run(async () => {
      const query = this.searchQuery.trim();
      const results = await this.request<SearchResult[]>(`/search?q=${encodeURIComponent(query)}`);
      await this.refresh();
      this.lastSearchQuery = query;
      this.results.set(results);
      this.searched.set(true);
    });
  }
}
