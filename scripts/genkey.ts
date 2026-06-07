import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
const kp = Ed25519Keypair.generate();
console.log('ADDR=' + kp.getPublicKey().toSuiAddress());
console.log('FLAG_B64=' + Buffer.from(kp.getSecretKey()).toString('base64'));
console.log('SECRET_LEN=' + kp.getSecretKey().length);
// Try toSuiAddress and toString
console.log('TO_STR=' + kp.toSuiAddress());
console.log('PUBKEY=' + kp.getPublicKey().toBase64());
