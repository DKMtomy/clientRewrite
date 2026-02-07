/**
 * Default skin data for Minecraft Bedrock client authentication.
 * Provides valid Steve skin geometry and RGBA pixel data (64x64).
 */

/** Minimal Steve geometry definition accepted by Bedrock servers. */
export const DEFAULT_SKIN_GEOMETRY = JSON.stringify({
	format_version: '1.12.0',
	'minecraft:geometry': [
		{
			description: {
				identifier: 'geometry.humanoid.custom',
				texture_width: 64,
				texture_height: 64,
				visible_bounds_width: 2,
				visible_bounds_height: 2,
				visible_bounds_offset: [0, 1, 0],
			},
			bones: [
				{ name: 'root', pivot: [0, 0, 0] },
				{
					name: 'body',
					parent: 'root',
					pivot: [0, 24, 0],
					cubes: [{ origin: [-4, 12, -2], size: [8, 12, 4], uv: [16, 16] }],
				},
				{
					name: 'head',
					parent: 'body',
					pivot: [0, 24, 0],
					cubes: [{ origin: [-4, 24, -4], size: [8, 8, 8], uv: [0, 0] }],
				},
				{
					name: 'hat',
					parent: 'head',
					pivot: [0, 24, 0],
					cubes: [{ origin: [-4, 24, -4], size: [8, 8, 8], uv: [32, 0], inflate: 0.5 }],
				},
				{
					name: 'rightArm',
					parent: 'body',
					pivot: [-5, 22, 0],
					cubes: [{ origin: [-8, 12, -2], size: [4, 12, 4], uv: [40, 16] }],
				},
				{
					name: 'leftArm',
					parent: 'body',
					pivot: [5, 22, 0],
					cubes: [{ origin: [4, 12, -2], size: [4, 12, 4], uv: [32, 48] }],
				},
				{
					name: 'rightLeg',
					parent: 'root',
					pivot: [-1.9, 12, 0],
					cubes: [{ origin: [-3.9, 0, -2], size: [4, 12, 4], uv: [0, 16] }],
				},
				{
					name: 'leftLeg',
					parent: 'root',
					pivot: [1.9, 12, 0],
					cubes: [{ origin: [-0.1, 0, -2], size: [4, 12, 4], uv: [16, 48] }],
				},
			],
		},
	],
});

/** Resource patch that maps geometry to skin. */
export const DEFAULT_SKIN_RESOURCE_PATCH = JSON.stringify({
	geometry: { default: 'geometry.humanoid.custom' },
});

/**
 * Generates a solid-color 64x64 RGBA skin image (16384 bytes).
 * Default color is classic Steve skin tone (#c8a06e).
 */
export function generateSkinImage(r = 200, g = 160, b = 110, a = 255): Buffer {
	const pixels = Buffer.alloc(64 * 64 * 4);
	for (let i = 0; i < 64 * 64; i++) {
		const offset = i * 4;
		pixels[offset] = r;
		pixels[offset + 1] = g;
		pixels[offset + 2] = b;
		pixels[offset + 3] = a;
	}
	return pixels;
}

/** Width/height of the default skin image. */
export const SKIN_IMAGE_WIDTH = 64;
export const SKIN_IMAGE_HEIGHT = 64;

/**
 * Builds the full skin data payload for the client user JWT chain.
 * Merges with any user-provided overrides.
 */
export function buildSkinData(
	skinId: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	const skinImage = generateSkinImage();

	return {
		AnimatedImageData: [],
		ArmSize: 'wide',
		CapeData: '',
		CapeId: '',
		CapeImageHeight: 0,
		CapeImageWidth: 0,
		CapeOnClassicSkin: false,
		PersonaPieces: [],
		PersonaSkin: false,
		PieceTintColors: [],
		PlayFabId: '',
		PremiumSkin: false,
		SkinAnimationData: '',
		SkinColor: '#0',
		SkinData: skinImage.toString('base64'),
		SkinGeometryData: Buffer.from(DEFAULT_SKIN_GEOMETRY).toString('base64'),
		SkinGeometryDataEngineVersion: '1.12.0',
		SkinId: skinId,
		SkinImageHeight: SKIN_IMAGE_HEIGHT,
		SkinImageWidth: SKIN_IMAGE_WIDTH,
		SkinResourcePatch: Buffer.from(DEFAULT_SKIN_RESOURCE_PATCH).toString('base64'),
		TrustedSkin: false,
		OverrideSkin: false,
		...overrides,
	};
}
