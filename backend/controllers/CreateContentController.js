const { GoogleGenAI } = require("@google/genai");
const pool = require("../db");

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";

// Retry Gemini calls that fail with temporary errors (overloaded / rate limited)
const RETRYABLE_STATUSES = [429, 500, 503];
async function withRetry(fn, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !RETRYABLE_STATUSES.includes(err.status)) {
        throw err;
      }
      const delayMs = 2000 * attempt;
      console.warn(
        `Gemini returned ${err.status}, retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${attempts})`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

exports.generateContent = async (req, res) => {
  const userId = req.user.id;
  const {
    businessName,
    targetAudience,
    contentType,
    duration,
    frequency,
    details,
  } = req.body;
  if (
    !businessName ||
    !targetAudience ||
    !contentType ||
    !duration ||
    !frequency ||
    !details
  ) {
    return res.status(400).json({ message: "All fields are required" });
  }

  const prompt = `
You are an expert AI content strategist and professional scriptwriter.

Generate a complete, structured social media content plan based on the following information:

BUSINESS INFO:
- Name: "${businessName}"
- Target Audience: "${targetAudience}"
- Content Type: "${contentType}" (e.g., short videos, long videos, carousels, posts, etc.)
- Plan Duration: "${duration}"
- Posting Frequency: "${frequency}"
- Additional Details: "${details}"

TASK:
1. Create a full content plan for the selected duration and posting frequency 
   (e.g., if 2 weeks daily = 14 content ideas).
2. Each content item must be fully detailed, practical, and directly ready for publishing.

For each content item, include:
- **day**: e.g., "Day 1"
- **title**: a catchy post title or hook.
- **idea**: a short description of the main content concept.
- **script**: a *ready-to-record, word-for-word* spoken script that the user can read directly on camera.
    - If the content type includes "short video" or "Reels" → make it 60–90 seconds long (about 100–120 words).
    - If the content type includes "long video" → make it **at least 5 minutes long** (about 700–900 words) with a clear intro, body, and outro.
    - Ensure the tone is natural, conversational, and brand-aligned.
- **caption**: a social media caption that summarizes or teases the content.
- **hashtags**: 5–10 relevant hashtags.
- **call_to_action**: a short CTA like “Subscribe for more”, “Book now”, or “Learn more”.
- **visual_suggestion**: describe visuals, b-roll, or camera shots that match the script.

Return the result in **strict JSON format** exactly like this:

{
  "content": [
    {
      "day": "Day 1",
      "title": "...",
      "idea": "...",
      "script": "Exact spoken script here (word-for-word).",
      "caption": "...",
      "hashtags": ["...", "..."],
      "call_to_action": "...",
      "visual_suggestion": "...",
      "content_type": "..."
    }
  ],
  "plan_details": {
    "duration": "${duration}",
    "frequency": "${frequency}"
  }
}

IMPORTANT RULES:
- Do NOT include Markdown, backticks, or explanations — only valid JSON.
- The "script" field must contain a **complete spoken script**, not just bullet points.
- Long video scripts must be detailed and flow naturally with storytelling and value.
- Match tone, style, and CTAs to the provided business info and target audience.
- The total number of content items must match the duration and posting frequency.
`;

  try {
    const startedAt = Date.now();
    const response = await withRetry(() =>
      genAI.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
        config: {
          // Ask Gemini for raw JSON so the response can be parsed directly
          responseMimeType: "application/json",
          // Thinking adds minutes of latency and isn't needed for this task
          thinkingConfig: { thinkingBudget: 0 },
        },
      })
    );
    const usage = response.usageMetadata || {};
    console.log(
      `Gemini ${GEMINI_MODEL}: ${((Date.now() - startedAt) / 1000).toFixed(1)}s, ` +
        `${usage.candidatesTokenCount ?? "?"} output tokens, ` +
        `${usage.thoughtsTokenCount ?? 0} thinking tokens`
    );

    // Strip a ```json fence in case the model adds one anyway
    const raw = (response.text || "")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");

    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      console.error("JSON Parse Error:", err);
      console.error("Raw response sample:", raw.slice(0, 500) + "...");
      return res.status(500).json({
        message:
          "AI returned incomplete data (too large to process). Try a shorter duration or lower posting frequency.",
      });
    }
    if (!data?.content || !Array.isArray(data.content)) {
      return res.status(500).json({
        message: "AI returned unexpected structure. Please try again.",
      });
    }

    const { content, plan_details } = data;
    const { duration, frequency } = plan_details;

    const draftResult = await pool.query(
      "INSERT INTO drafts (user_id, title, duration, frequency) VALUES ($1, $2, $3, $4) RETURNING id",
      [userId, businessName, duration, frequency]
    );

    const draftId = draftResult.rows[0].id;

    for (const con of content) {
      const contentResult = await pool.query(
        "INSERT INTO content (draft_id, day, title, idea, script, caption, hashtags, call_to_action, visual_suggestion, content_type) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        [
          draftId,
          con.day,
          con.title,
          con.idea,
          con.script,
          con.caption,
          JSON.stringify(con.hashtags),
          con.call_to_action,
          con.visual_suggestion,
          con.content_type,
        ]
      );
    }

    res.status(201).json({
      message: "Ai-generated plan successfully",
      draftId,
      content,
      duration,
      frequency,
    });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ message: "Failed to generate content plan. Please try again." });
  }
};

exports.getAllDrafts = async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await pool.query(
      "SELECT id, title, duration, frequency, created_at FROM drafts WHERE user_id = $1",
      [userId]
    );

    res
      .status(200)
      .json({ message: "Fetched successfullt", drafts: result.rows });
  } catch (err) {
    console.error(err);
  }
};

exports.getContentByDraftId = async (req, res) => {
  const { draftId } = req.params;

  try {
    const contentResult = await pool.query(
      "SELECT * FROM content WHERE draft_id = $1",
      [draftId]
    );

    const scheduleResult = await pool.query(
      "SELECT duration, frequency FROM drafts WHERE id = $1",
      [draftId]
    );

    const schedule = scheduleResult.rows[0] || {};

    res.status(200).json({
      message: "content fetched successfully",
      content: contentResult.rows,
      duration: schedule?.duration,
      frequency: schedule?.frequency,
    });
  } catch (err) {
    console.error(err);
  }
};

exports.editContent = async (req, res) => {
  const { id } = req.params;
  const {
    title,
    idea,
    script,
    caption,
    hashtags,
    call_to_action,
    visual_suggestion,
  } = req.body;

  if (
    !title ||
    !idea ||
    !script ||
    !caption ||
    !hashtags ||
    !call_to_action ||
    !visual_suggestion
  ) {
    return res.status(400).json({ message: "All fields are required" });
  }

  try {
    const result = await pool.query(
      "UPDATE content SET title = $1, idea = $2, script = $3, caption = $4, hashtags = $5, call_to_action = $6, visual_suggestion= $7 WHERE id = $8",
      [
        title,
        idea,
        script,
        caption,
        JSON.stringify(hashtags),
        call_to_action,
        visual_suggestion,
        id,
      ]
    );

    res.status(200).json({ message: "Updated successfully" });
  } catch (err) {
    console.error(err);
  }
};

exports.deleteContent = async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM content WHERE id = $1", [id]);

    res.status(200).json({ message: "Content deleted successfully" });
  } catch (err) {
    console.error(err);
  }
};
