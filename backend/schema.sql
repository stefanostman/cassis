CREATE TABLE IF NOT EXISTS cassis_users (
  id CHAR(36) PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS cassis_sessions (
  token_hash CHAR(64) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  expires_at DATETIME NOT NULL,
  FOREIGN KEY (user_id) REFERENCES cassis_users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS cassis_objects (
  objectId CHAR(36) PRIMARY KEY,
  objectType VARCHAR(50) NOT NULL,
  created DATETIME(3) NOT NULL,
  createdBy VARCHAR(50) NOT NULL,
  lastUpdated DATETIME(3) NOT NULL,
  lastUpdatedBy VARCHAR(50) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS cassis_valuelists (
  objectId CHAR(36) PRIMARY KEY,
  listName VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  listDescription VARCHAR(255) NOT NULL DEFAULT '',
  UNIQUE (listName),
  FOREIGN KEY (objectId) REFERENCES cassis_objects(objectId) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS cassis_valuelistelements (
  objectId CHAR(36) PRIMARY KEY,
  listId CHAR(36) NOT NULL,
  value VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  UNIQUE (listId, value),
  CHECK (CHAR_LENGTH(value) > 0),
  FOREIGN KEY (objectId) REFERENCES cassis_objects(objectId) ON DELETE CASCADE,
  FOREIGN KEY (listId) REFERENCES cassis_valuelists(objectId)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS cassis_user_roles (
  userId CHAR(36) NOT NULL,
  roleId CHAR(36) NOT NULL,
  PRIMARY KEY (userId, roleId),
  FOREIGN KEY (userId) REFERENCES cassis_users(id) ON DELETE CASCADE,
  FOREIGN KEY (roleId) REFERENCES cassis_valuelistelements(objectId)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS base_case (
  objectId CHAR(36) PRIMARY KEY,
  diaryNumber VARCHAR(20) NOT NULL,
  classification VARCHAR(8) NOT NULL,
  classification_ValueList VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT 'classification',
  extraclass_ValueList VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT 'extraClass',
  caseSentence VARCHAR(100) NOT NULL,
  CONSTRAINT chk_case_classification_list CHECK (BINARY classification_ValueList = BINARY 'classification'),
  CONSTRAINT chk_case_extraclass_list CHECK (BINARY extraclass_ValueList = BINARY 'extraClass'),
  FOREIGN KEY (objectId) REFERENCES cassis_objects(objectId) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS case_extraclass (
  caseId CHAR(36) NOT NULL,
  position INT NOT NULL,
  value VARCHAR(50) NOT NULL,
  value_ValueList VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT 'extraClass',
  PRIMARY KEY (caseId, position),
  CONSTRAINT chk_extra_value_list CHECK (BINARY value_ValueList = BINARY 'extraClass'),
  FOREIGN KEY (caseId) REFERENCES base_case(objectId) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS base_record (
  objectId CHAR(36) PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  description VARCHAR(100) NOT NULL,
  recordType VARCHAR(100) NOT NULL,
  recordType_ValueList VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT 'recordType',
  CONSTRAINT chk_record_type_list CHECK (BINARY recordType_ValueList = BINARY 'recordType'),
  FOREIGN KEY (objectId) REFERENCES cassis_objects(objectId) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS base_document (
  objectId CHAR(36) PRIMARY KEY,
  recordId CHAR(36) NOT NULL,
  name VARCHAR(100) NOT NULL,
  documentType VARCHAR(100) NOT NULL,
  documentType_ValueList VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT 'documentType',
  filetype VARCHAR(4) NOT NULL,
  filesize INT UNSIGNED NOT NULL,
  filename VARCHAR(41) NOT NULL,
  originalFilename VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  CONSTRAINT chk_document_type_list CHECK (BINARY documentType_ValueList = BINARY 'documentType'),
  FOREIGN KEY (objectId) REFERENCES cassis_objects(objectId) ON DELETE CASCADE,
  FOREIGN KEY (recordId) REFERENCES base_record(objectId) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS cassis_relations (
  id CHAR(36) PRIMARY KEY,
  sourceId CHAR(36) NOT NULL,
  targetId CHAR(36) NOT NULL,
  objectTypes VARCHAR(101) NOT NULL,
  relationType VARCHAR(100) NOT NULL DEFAULT '',
  UNIQUE (sourceId, targetId, relationType),
  FOREIGN KEY (sourceId) REFERENCES cassis_objects(objectId) ON DELETE CASCADE,
  FOREIGN KEY (targetId) REFERENCES cassis_objects(objectId) ON DELETE CASCADE
) ENGINE=InnoDB;
