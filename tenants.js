const { mimeType } = require("./onlyoffice");

/**
 * Adapter HTTP del storage de los tenants: descarga la versión editada de OnlyOffice y la sube con un PUT
 * prefirmado que el tenant emite en su saveUrl en ese momento.
 * @param {Object} deps
 * @param {Record<string, { saveUrl: string }>} deps.tenants - client_id (azp) → saveUrl. La saveUrl es configuración
 *   de Roffice, no del request, para no enviar su token de servicio a URLs arbitrarias.
 * @param {{ getServiceToken: () => Promise<string> }} deps.oidc
 * @returns {(session: { tenant: string, docId: string, version: string, fileType: string }, downloadUrl: string) => Promise<void>}
 */
function createSaveToTenant({ tenants, oidc }) {
  return async function saveToTenant({ tenant, docId, version, fileType }, downloadUrl) {
    const download = await fetch(downloadUrl);
    if (!download.ok) throw new Error(`Descarga desde OnlyOffice respondió ${download.status}`);
    const file = Buffer.from(await download.arrayBuffer());
    const contentType = mimeType(fileType);

    const grant = await fetch(tenants[tenant].saveUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${await oidc.getServiceToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ docId, version, contentType }),
    });
    if (!grant.ok) throw new Error(`saveUrl de ${tenant} respondió ${grant.status}`);
    const { putUrl } = await grant.json();
    if (!/^https?:\/\//.test(putUrl)) throw new Error(`saveUrl de ${tenant} no devolvió putUrl`);

    const upload = await fetch(putUrl, { method: "PUT", headers: { "Content-Type": contentType }, body: file });
    if (!upload.ok) throw new Error(`PUT al storage de ${tenant} respondió ${upload.status}`);
  };
}

module.exports = { createSaveToTenant };
