'use strict';

const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * MEDICAL DATA ENCRYPTION
 * 
 * Encrypts sensitive medical information at rest.
 * Uses AES-256-GCM with authentication tags to detect tampering.
 * 
 * NOTE: Encryption key must be:
 * - 32 bytes (256 bits) for AES-256
 * - Stored securely in environment variable ENCRYPTION_KEY
 * - Rotated regularly (generate: crypto.randomBytes(32).toString('hex'))
 * - NOT hardcoded or committed to version control
 * 
 * Fields encrypted:
 * - Medical records (diagnosis, treatment)
 * - Vitals (heart rate, blood pressure, etc.)
 * - Allergies and medical history
 * - Patient PII (name, phone in some contexts)
 */

// Get encryption key from environment
const getEncryptionKey = () => {
  const key = process.env.ENCRYPTION_KEY;
  
  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('ENCRYPTION_KEY environment variable not set - cannot encrypt medical data');
    }
    logger.warn('ENCRYPTION_KEY not set - using default for development only');
    // Development default - NEVER USE IN PRODUCTION
    // 32 zero bytes, represented as 64 hexadecimal characters.
    return Buffer.from('0000000000000000000000000000000000000000000000000000000000000000', 'hex');
  }

  if (!/^[0-9a-fA-F]{64}$/.test(key)) { // 32 bytes = 64 hex characters
    throw new Error('ENCRYPTION_KEY must be exactly 64 hexadecimal characters');
  }

  return Buffer.from(key, 'hex');
};

/**
 * Encrypt sensitive data using AES-256-GCM
 * 
 * @param {string|object} plaintext - Data to encrypt
 * @returns {{iv: string, ciphertext: string, authTag: string, algorithm: string}}
 */
const encrypt = (plaintext) => {
  try {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(16); // 128-bit IV
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    // Convert object to JSON if needed
    const data = typeof plaintext === 'object' 
      ? JSON.stringify(plaintext) 
      : String(plaintext);

    let ciphertext = cipher.update(data, 'utf8', 'hex');
    ciphertext += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    return {
      iv: iv.toString('hex'),
      ciphertext,
      authTag: authTag.toString('hex'),
      algorithm: 'aes-256-gcm'
    };
  } catch (err) {
    logger.error('Encryption failed', { error: err.message });
    throw err;
  }
};

/**
 * Decrypt data encrypted with encrypt()
 * Validates authentication tag to detect tampering
 * 
 * @param {{iv: string, ciphertext: string, authTag: string}} encrypted
 * @param {boolean} parseJson - If true, parse result as JSON
 * @returns {string|object} Decrypted data
 */
const decrypt = (encrypted, parseJson = false) => {
  try {
    const key = getEncryptionKey();
    
    if (!encrypted || !encrypted.iv || !encrypted.ciphertext || !encrypted.authTag) {
      throw new Error('Invalid encrypted data format');
    }

    const iv = Buffer.from(encrypted.iv, 'hex');
    const ciphertext = Buffer.from(encrypted.ciphertext, 'hex');
    const authTag = Buffer.from(encrypted.authTag, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let plaintext = decipher.update(ciphertext, 'hex', 'utf8');
    plaintext += decipher.final('utf8');

    // Parse JSON if requested
    if (parseJson) {
      try {
        return JSON.parse(plaintext);
      } catch (e) {
        return plaintext; // Return as string if not valid JSON
      }
    }

    return plaintext;
  } catch (err) {
    logger.error('Decryption failed', { error: err.message });
    throw err;
  }
};

/**
 * Hash sensitive data for comparison without storing plaintext
 * Use for: passwords (via bcrypt), API keys, SSNs
 */
const hashData = (data) => {
  return crypto
    .createHash('sha256')
    .update(data)
    .digest('hex');
};

/**
 * Generate a cryptographically secure random token
 * Use for: password reset tokens, API keys, session tokens
 */
const generateToken = (length = 32) => {
  return crypto.randomBytes(length).toString('hex');
};

/**
 * Encrypt medical vitals
 */
const encryptVitals = (vitals) => {
  if (!vitals) return null;

  const toEncrypt = {
    heartRate: vitals.heartRate,
    bloodPressure: vitals.bloodPressure,
    respiratoryRate: vitals.respiratoryRate,
    temperature: vitals.temperature,
    oxygenSaturation: vitals.oxygenSaturation,
    timestamp: new Date()
  };

  return encrypt(toEncrypt);
};

/**
 * Decrypt medical vitals
 */
const decryptVitals = (encryptedVitals) => {
  if (!encryptedVitals) return null;

  try {
    return decrypt(encryptedVitals, true);
  } catch (err) {
    logger.error('Failed to decrypt vitals', { error: err.message });
    return null;
  }
};

/**
 * Encrypt medical record data
 */
const encryptMedicalRecord = (record) => {
  if (!record) return null;

  const toEncrypt = {
    diagnosis: record.diagnosis,
    treatment: record.treatment,
    medications: record.medications,
    allergies: record.allergies,
    medicalHistory: record.medicalHistory,
    notes: record.notes,
    timestamp: new Date()
  };

  return encrypt(toEncrypt);
};

/**
 * Decrypt medical record
 */
const decryptMedicalRecord = (encryptedRecord) => {
  if (!encryptedRecord) return null;

  try {
    return decrypt(encryptedRecord, true);
  } catch (err) {
    logger.error('Failed to decrypt medical record', { error: err.message });
    return null;
  }
};

/**
 * Middleware to decrypt medical fields on load
 * Usage: apply to routes that return medical data
 */
const decryptMedicalFields = (schema) => {
  schema.methods.decryptMedicalData = function() {
    if (this.encryptedVitals) {
      this.vitals = decryptVitals(this.encryptedVitals);
    }
    if (this.encryptedMedicalRecord) {
      this.medicalRecord = decryptMedicalRecord(this.encryptedMedicalRecord);
    }
    return this;
  };

  schema.methods.encryptMedicalData = function() {
    if (this.vitals) {
      this.encryptedVitals = encryptVitals(this.vitals);
    }
    if (this.medicalRecord) {
      this.encryptedMedicalRecord = encryptMedicalRecord(this.medicalRecord);
    }
    return this;
  };
};

/**
 * Key rotation utility
 * For emergency key rotation without data loss
 */
const rotateEncryptionKey = async (oldEncryptedData, oldKey, newKey) => {
  try {
    // Decrypt with old key
    const decipher = crypto.createDecipheriv('aes-256-gcm',
      Buffer.from(oldKey, 'hex'),
      Buffer.from(oldEncryptedData.iv, 'hex')
    );
    decipher.setAuthTag(Buffer.from(oldEncryptedData.authTag, 'hex'));
    
    let plaintext = decipher.update(oldEncryptedData.ciphertext, 'hex', 'utf8');
    plaintext += decipher.final('utf8');

    // Re-encrypt with new key
    const newIv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm',
      Buffer.from(newKey, 'hex'),
      newIv
    );

    let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
    ciphertext += cipher.final('hex');

    return {
      iv: newIv.toString('hex'),
      ciphertext,
      authTag: cipher.getAuthTag().toString('hex'),
      algorithm: 'aes-256-gcm'
    };
  } catch (err) {
    logger.error('Key rotation failed', { error: err.message });
    throw err;
  }
};

/**
 * Verify encryption key is valid
 */
const verifyEncryptionKey = () => {
  try {
    const key = getEncryptionKey();
    if (key.length !== 32) {
      throw new Error('Invalid key length');
    }
    
    // Test encrypt/decrypt
    const testData = 'test-encryption-key-validity';
    const encrypted = encrypt(testData);
    const decrypted = decrypt(encrypted);
    
    if (decrypted !== testData) {
      throw new Error('Encryption verification failed');
    }

    logger.info('Encryption key verified successfully');
    return true;
  } catch (err) {
    logger.error('Encryption key verification failed', { error: err.message });
    return false;
  }
};

module.exports = {
  encrypt,
  decrypt,
  hashData,
  generateToken,
  encryptVitals,
  decryptVitals,
  encryptMedicalRecord,
  decryptMedicalRecord,
  decryptMedicalFields,
  rotateEncryptionKey,
  verifyEncryptionKey,
  getEncryptionKey
};
