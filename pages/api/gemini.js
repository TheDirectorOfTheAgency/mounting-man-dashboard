// Gemini API proxy — keeps API key server-side
// Used by the accent wall visualizer iframe page

import { GoogleGenAI } from '@google/genai';

const GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '6mb',
    },
  },
  maxDuration: 60,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'Gemini API key not configured' });
  }

  const { action, imageData, mimeType, prompt } = req.body;

  if (!action || !prompt) {
    return res.status(400).json({ error: 'Missing required fields: action, prompt' });
  }

  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

  try {
    if (action === 'generate-image') {
      if (!imageData || !mimeType) {
        return res.status(400).json({ error: 'Missing imageData or mimeType for image generation' });
      }

      const fullPrompt = `${prompt}. In the generated image, please make sure the entire room is clean and tidy. Remove any clutter, toys, or messes from the floor and surfaces to present a clean living space.`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: {
          parts: [
            { inlineData: { data: imageData, mimeType } },
            { text: fullPrompt },
          ],
        },
        config: { responseModalities: ['IMAGE'] },
      });

      for (const part of response.candidates?.[0]?.content?.parts ?? []) {
        if (part.inlineData) {
          return res.status(200).json({ imageData: part.inlineData.data });
        }
      }

      return res.status(200).json({ imageData: null, message: 'No image returned by the model' });

    } else if (action === 'cost-estimate') {
      const systemInstruction = `You are an AI assistant for a TV mounting and accent wall company called The Mounting Man in the Twin Cities area. Your task is to provide a rough, non-binding cost estimate based on a user's description. Break down costs into individual items and provide a total. Costs should be realistic for the US market. Always include a disclaimer. Respond ONLY with JSON.`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-pro',
        contents: `Please provide a cost estimate for: "${prompt}"`,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              items: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    item: { type: 'STRING' },
                    cost: { type: 'STRING' },
                  },
                  required: ['item', 'cost'],
                },
              },
              total: { type: 'STRING' },
              disclaimer: { type: 'STRING' },
            },
            required: ['items', 'total', 'disclaimer'],
          },
        },
      });

      const jsonString = response.text;
      if (jsonString) {
        return res.status(200).json({ estimate: JSON.parse(jsonString) });
      }
      return res.status(200).json({ estimate: null, message: 'No estimate returned' });

    } else {
      return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (error) {
    console.error('Gemini API error:', error);
    return res.status(500).json({
      error: error.message || 'Gemini API call failed',
    });
  }
}
