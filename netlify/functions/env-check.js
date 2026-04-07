/**
 * Health check — verifies all required env vars are set
 * GET /api/env-check
 */
exports.handler = async () => {
  const checks = [
    { name: "META_ACCESS_TOKEN", ok: !!process.env.META_ACCESS_TOKEN },
    { name: "META_AD_ACCOUNT_ID", ok: !!process.env.META_AD_ACCOUNT_ID },
    { name: "GOOGLE_SHEET_ID", ok: !!process.env.GOOGLE_SHEET_ID },
    { name: "GOOGLE_SA_PRIVATE_KEY", ok: !!process.env.GOOGLE_SA_PRIVATE_KEY },
    { name: "GOOGLE_SA_EMAIL", ok: !!process.env.GOOGLE_SA_EMAIL },
    { name: "TELEGRAM_BOT_TOKEN", ok: !!process.env.TELEGRAM_BOT_TOKEN },
    { name: "TELEGRAM_CHAT_ID", ok: !!process.env.TELEGRAM_CHAT_ID },
    { name: "ANTHROPIC_API_KEY", ok: !!process.env.ANTHROPIC_API_KEY },
  ];

  const allOk = checks.every((c) => c.ok);

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify({ allOk, checks }),
  };
};
