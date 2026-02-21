// pages/api/webflow-posts.js
import axios from 'axios';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const token = process.env.NEXT_PUBLIC_WEBFLOW_TOKEN;
    const collectionId = process.env.NEXT_PUBLIC_WEBFLOW_INSTALLATIONS_COLLECTION_ID;

    if (!token || !collectionId) {
      return res.status(400).json({ error: 'Missing Webflow credentials', hasToken: !!token, hasCollection: !!collectionId });
    }

    // Paginate through all items
    let allItems = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const response = await axios.get(
        `https://api.webflow.com/v2/collections/${collectionId}/items`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
          params: { limit, offset },
        }
      );

      const items = response.data.items || [];
      allItems = allItems.concat(items);

      if (items.length < limit) break;
      offset += limit;
    }

    const published = allItems.filter(item => !item.isArchived && !item.isDraft).length;
    const draft = allItems.filter(item => item.isDraft).length;
    const archived = allItems.filter(item => item.isArchived).length;

    res.status(200).json({
      published,
      draft,
      archived,
      total: allItems.length,
      lastUpdated: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Webflow API error:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to fetch Webflow data',
      details: error.response?.data || error.message,
    });
  }
}
