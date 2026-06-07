import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
const kp = Ed25519Keypair.generate();
const secret = kp.getSecretKey();
console.log('ADDR=' + kp.getPublicKey().toSuiAddress());
console.log('BECH32=' + secret);
console.log('B64=' + Buffer.from(secret).toString('base64'));
