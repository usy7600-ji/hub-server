const DETAIL_MAX_LEN = 500;

function sendHttpError(res, { statusCode, error, detail, code }) {
  const resolvedStatusCode = Number(statusCode);
  const payload = {
    error: String(error),
    detail: String(detail || "").slice(0, DETAIL_MAX_LEN)
  };

  if (typeof code !== "undefined") {
    payload.code = Number(code);
  }

  res.statusCode = Number.isInteger(resolvedStatusCode) && resolvedStatusCode >= 100
    ? resolvedStatusCode
    : 500;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

module.exports = {
  sendHttpError
};
