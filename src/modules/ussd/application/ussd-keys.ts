import { createPrivateKey, type KeyObject } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../../config/app-config';

/**
 * RSA private keys for the USSD flow (our key pair; the public key is pasted
 * into the flow's Security section in the Monime dashboard). Current first,
 * then the previous one during a rotation.
 */
@Injectable()
export class UssdKeys {
  private readonly logger = new Logger(UssdKeys.name);
  readonly keys: KeyObject[];

  constructor(config: AppConfig) {
    this.keys = [config.get('USSD_RSA_PRIVATE_KEY'), config.get('USSD_RSA_PRIVATE_KEY_PREVIOUS')]
      .filter((pem): pem is string => Boolean(pem))
      .map((pem, i) => load(pem, i === 0 ? 'USSD_RSA_PRIVATE_KEY' : 'USSD_RSA_PRIVATE_KEY_PREVIOUS'));
    if (this.keys.length === 0) this.logger.warn('USSD_RSA_PRIVATE_KEY not set; the USSD exchange endpoint is disabled');
  }
}

function load(raw: string, name: string): KeyObject {
  let pem = raw.trim();
  if (pem.startsWith('"') && pem.endsWith('"')) pem = pem.slice(1, -1);
  pem = pem.replace(/\\n/g, '\n');
  if (!pem.includes('-----BEGIN PRIVATE KEY-----')) throw new Error(`${name} must be a PKCS#8 PEM (-----BEGIN PRIVATE KEY-----)`);
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 2048) {
    throw new Error(`${name} must be an RSA 2048-bit key (Monime rejects other sizes)`);
  }
  return key;
}
