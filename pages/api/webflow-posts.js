// pages/api/webflow-posts.js
import axios from 'axios';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const token = process.env.NEXT_PUBLIC_WEBFLOW_TOKEN;
    const siteId = process.env.NEXT_PUBLIC_WEBFLOW_SITE_ID;
    const collectionId = process.env.NEXT_PUBLIC_WEBFLOW_INSTALLATIONS_COLLECTION_ID;

    if (!token || !siteId || !collectionId) {
      return res.status(400).json({ error: 'Missing Webflow credentials' });
    }

    // Get all items from Installations collection
    const response = await axios.get(
      `https://api.webflow.com/v1/collections/${collectionId}/items`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'accept-version': '1.0',
        },
      }
    );

    const items = response.data.items || [];
    
    // Filter for published posts only
    const publishedPosts = items.filter(item => !item.archived && !item.draft);
    
    // Count by status and extract other metrics
    const draftCount = items.filter(item => item.draft).length;
    const archivedCount = items.filter(item => item.archived).length;

    res.status(200).json({
      published: publishedPosts.length,
      draft: draftCount,
      archived: archivedCount,
      total: items.length,
      lastUpdated: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Webflow API error:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to fetch Webflow data',
      details: error.message,
    });
  }
}
