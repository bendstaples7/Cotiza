import { PlatformError } from '../errors/index.js';
import { EXTERNAL } from '../config.js';
import type { ImageGenerationRequest, GeneratedImage } from 'shared';

const GENERATION_TIMEOUT_MS = 120_000; // 120 seconds
const OPENAI_IMAGE_URL = EXTERNAL.openai.imageUrl;
const OPENAI_CHAT_URL = EXTERNAL.openai.chatUrl;
const SCENE_TIMEOUT_MS = 15_000;

export class ImageGenerator {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Generate images using OpenAI GPT-Image-1.
   * Returns 1024x1024 PNG images as base64 data URIs.
   */
  async generate(request: ImageGenerationRequest): Promise<GeneratedImage[]> {
    if (!this.apiKey) {
      throw new PlatformError({
        severity: 'error',
        component: 'ImageGenerator',
        operation: 'generate',
        description: 'OpenAI API key is not configured.',
        recommendedActions: ['Set AI_TEXT_API_KEY in your environment'],
      });
    }

    const count = Math.min(request.count ?? 1, 4);
    const styleHint = request.style === 'illustrative'
      ? 'Digital illustration, clean vector art style.'
      : request.style === 'modern'
      ? 'Modern minimalist interior design photography, clean lines, neutral tones.'
      : 'Shot on Canon EOS R5, 35mm lens, natural lighting, editorial interior photography, shallow depth of field, realistic textures and materials.';
    const prompt = styleHint + ' Absolutely no text, no words, no labels, no watermarks, no logos, no overlays. ' + request.description;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS);

    try {
      const response = await fetch(OPENAI_IMAGE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + this.apiKey,
        },
        body: JSON.stringify({
          model: EXTERNAL.openai.imageModel,
          prompt: prompt,
          n: count,
          size: '1024x1024',
          quality: 'medium',
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new PlatformError({
          severity: 'error',
          component: 'ImageGenerator',
          operation: 'generate',
          description: 'GPT-Image-1 API error (' + response.status + '): ' + errText,
          recommendedActions: ['Try again', 'Simplify the description'],
        });
      }

      const data = (await response.json()) as {
        data: Array<{ b64_json?: string; url?: string }>;
      };

      if (!data.data || data.data.length === 0) {
        throw new PlatformError({
          severity: 'error',
          component: 'ImageGenerator',
          operation: 'generate',
          description: 'No images were returned from GPT-Image-1.',
          recommendedActions: ['Try again with a different description'],
        });
      }

      const images: GeneratedImage[] = [];
      for (const item of data.data) {
        const b64 = item.b64_json;
        if (!b64) continue;
        const dataUri = 'data:image/png;base64,' + b64;
        images.push({
          url: dataUri,
          format: 'png',
          width: 1024,
          height: 1024,
          description: request.description,
        });
      }

      if (images.length === 0) {
        throw new PlatformError({
          severity: 'error',
          component: 'ImageGenerator',
          operation: 'generate',
          description: 'No valid image data was returned from GPT-Image-1.',
          recommendedActions: ['Try again with a different description'],
        });
      }

      return images;
    } catch (err) {
      if (err instanceof PlatformError) throw err;
      const isAbort = err instanceof Error && err.name === 'AbortError';
      throw new PlatformError({
        severity: 'error',
        component: 'ImageGenerator',
        operation: 'generate',
        description: isAbort
          ? 'Image generation timed out after 120 seconds.'
          : 'Image generation failed: ' + (err instanceof Error ? err.message : 'Unknown error'),
        recommendedActions: ['Try again', 'Simplify the description'],
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Use GPT to convert a content idea/topic into a concrete visual scene
   * description suitable for image generation.
   */
  async describeScene(topic: string): Promise<string> {
    if (!this.apiKey) {
      throw new PlatformError({
        severity: 'error',
        component: 'ImageGenerator',
        operation: 'describeScene',
        description: 'OpenAI API key is not configured.',
        recommendedActions: ['Set AI_TEXT_API_KEY in your environment'],
      });
    }

    const systemPrompt = [
      'You convert Instagram post topics into vivid, concrete photo scene descriptions for an AI image generator.',
      'The photos are for Chicago Reno, a home renovation company.',
      'Rules:',
      '- Describe a specific, realistic scene that a photographer could actually capture',
      '- Include specific details: objects, materials, lighting, camera angle',
      '- Keep it under 100 words',
      '- Never include text, words, logos, or watermarks in the scene',
      '- Focus on the visual subject matter, not abstract concepts',
      '- Return ONLY the scene description, nothing else',
    ].join('\n');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SCENE_TIMEOUT_MS);

    try {
      const response = await fetch(OPENAI_CHAT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + this.apiKey,
        },
        body: JSON.stringify({
          model: EXTERNAL.openai.chatModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: 'Topic: ' + topic },
          ],
          temperature: 0.9,
          max_tokens: 200,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new PlatformError({
          severity: 'error',
          component: 'ImageGenerator',
          operation: 'describeScene',
          description: 'Scene description failed (' + response.status + '): ' + errText,
          recommendedActions: ['Try again'],
        });
      }

      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      return data.choices?.[0]?.message?.content?.trim() ?? topic;
    } catch (err) {
      if (err instanceof PlatformError) throw err;
      // Fallback to the raw topic if scene description fails
      return topic;
    } finally {
      clearTimeout(timeout);
    }
  }
}
