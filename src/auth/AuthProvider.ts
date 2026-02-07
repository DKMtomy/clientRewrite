/**
 * Handles Xbox Live authentication and JWT chain building.
 * Single Responsibility: authentication concerns only.
 */
import * as crypto from 'crypto';
import JWT, { SignOptions } from 'jsonwebtoken';
import * as UUID from 'uuid-1345';
import { Authflow, Titles } from 'prismarine-auth';
import { buildSkinData } from './SkinData';
import type { ClientOptions, PlayerProfile } from '@/types';
import { MOJANG_PUBLIC_KEY } from '@/types';

export interface AuthResult {
	profile: PlayerProfile;
	identityChain: string;
	userChain: string;
	accessTokenChains: string[];
}

export interface KeyPair {
	ecdhKeyPair: crypto.KeyPairKeyObjectResult;
	publicKeyDER: Buffer;
	privateKeyPEM: string | Buffer;
	x509: string;
}

const EC_CURVE = 'secp384r1';
const JWT_ALGORITHM = 'ES384';

/** Generates a fresh ECDH key pair for authentication. */
export function generateKeyPair(): KeyPair {
	const ecdhKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: EC_CURVE });
	const publicKeyDER = ecdhKeyPair.publicKey.export({ format: 'der', type: 'spki' });
	const privateKeyPEM = ecdhKeyPair.privateKey.export({ format: 'pem', type: 'sec1' });
	const x509 = publicKeyDER.toString('base64');
	return { ecdhKeyPair, publicKeyDER, privateKeyPEM, x509 };
}

/** Generates a deterministic UUID from a string input. */
function uuidFrom(input: string): string {
	return UUID.v3({ namespace: '6ba7b811-9dad-11d1-80b4-00c04fd430c8', name: input });
}

/** Generates a random-ish UUID. */
function nextUUID(): string {
	return uuidFrom(Date.now().toString() + Math.random().toString());
}

/**
 * Authenticates with Xbox Live via prismarine-auth.
 * Returns the chain tokens and extracted profile.
 */
async function authenticateXbox(
	x509: string,
	username: string,
): Promise<{ chains: string[]; profile: PlayerProfile }> {
	const auth = new Authflow(username, 'auth', {
		flow: 'live',
		deviceType: 'Nintendo',
		authTitle: Titles.MinecraftNintendoSwitch,
	});

	// @ts-expect-error - prismarine-auth types may not match exactly
	const chains: string[] = await auth.getMinecraftBedrockToken(x509);

	const lastChain = chains[chains.length - 1]!;
	const payload = JSON.parse(Buffer.from(lastChain.split('.')[1]!, 'base64').toString());

	const profile: PlayerProfile = {
		name: payload?.extraData?.displayName || username,
		uuid: payload?.extraData?.identity || uuidFrom(username),
		xuid: payload?.extraData?.XUID || '0',
	};

	return { chains, profile };
}

/** Signs a JWT with the client's ECDH private key. */
function signJwt(
	payload: Record<string, unknown>,
	privateKey: crypto.KeyObject,
	x509: string,
	options: Partial<SignOptions> = {},
): string {
	return JWT.sign(payload, privateKey, {
		algorithm: JWT_ALGORITHM,
		header: { alg: JWT_ALGORITHM, x5u: x509, typ: undefined },
		...options,
	});
}

/** Builds the identity chain JWT (online or offline). */
function buildIdentityChain(
	keyPair: KeyPair,
	profile: PlayerProfile,
	accessTokenChains: string[],
	offline: boolean,
): string {
	const privateKey = keyPair.ecdhKeyPair.privateKey;

	if (offline) {
		return signJwt(
			{
				extraData: {
					displayName: profile.name,
					identity: profile.uuid,
					titleId: '89692877',
					XUID: profile.xuid,
				},
				certificateAuthority: true,
				identityPublicKey: keyPair.x509,
			},
			privateKey,
			keyPair.x509,
			{ notBefore: 0, issuer: 'self', expiresIn: 3600 },
		);
	}

	// Online: extract Mojang key from first chain header
	let mojangKey = MOJANG_PUBLIC_KEY;
	if (accessTokenChains.length > 0) {
		try {
			const header = JSON.parse(
				Buffer.from(accessTokenChains[0]!.split('.')[0]!, 'base64').toString(),
			);
			if (header.x5u) mojangKey = header.x5u;
		} catch {
			// Fallback to default
		}
	}

	return signJwt(
		{ identityPublicKey: mojangKey, certificateAuthority: true },
		privateKey,
		keyPair.x509,
	);
}

/** Builds the user chain JWT with skin data and device info. */
function buildUserChain(
	keyPair: KeyPair,
	profile: PlayerProfile,
	options: ClientOptions,
): string {
	const skinId = `${profile.uuid}-Custom`;

	const skinPayload = buildSkinData(skinId, options.skinData);

	const payload: Record<string, unknown> = {
		...skinPayload,
		ClientRandomId: Date.now(),
		CurrentInputMode: 1,
		DefaultInputMode: 1,
		DeviceId: nextUUID(),
		DeviceModel: 'BedrockClient',
		DeviceOS: options.deviceOS ?? 7,
		GameVersion: options.gameVersion!,
		GuiScale: -1,
		LanguageCode: 'en_GB',
		PlatformOfflineId: '',
		PlatformOnlineId: '',
		PlayFabId: nextUUID().replace(/-/g, '').slice(0, 16),
		SelfSignedId: nextUUID(),
		ServerAddress: `${options.host}:${options.port}`,
		ThirdPartyName: profile.name,
		ThirdPartyNameOnly: false,
		UIProfile: 0,
		IsEditorMode: false,
		CompatibleWithClientSideChunkGen: false,
	};

	return JWT.sign(payload, keyPair.ecdhKeyPair.privateKey, {
		algorithm: JWT_ALGORITHM,
		header: { alg: JWT_ALGORITHM, x5u: keyPair.x509, typ: 'JWT' },
		noTimestamp: true,
	});
}

/**
 * Full authentication flow: Xbox auth (if online) + chain building.
 * Returns everything the Client needs to send a Login packet.
 */
export async function authenticate(
	keyPair: KeyPair,
	options: ClientOptions,
): Promise<AuthResult> {
	let profile: PlayerProfile;
	let accessTokenChains: string[] = [];

	if (options.offline) {
		profile = {
			name: options.username || 'Player',
			uuid: uuidFrom(options.username || 'Player'),
			xuid: '0',
		};
	} else {
		const result = await authenticateXbox(keyPair.x509, options.username || 'Player');
		profile = result.profile;
		accessTokenChains = result.chains;
	}

	const identityChain = buildIdentityChain(keyPair, profile, accessTokenChains, !!options.offline);
	const userChain = buildUserChain(keyPair, profile, options);

	return { profile, identityChain, userChain, accessTokenChains };
}
