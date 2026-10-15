/**
 * Documentos abiertos por un usuario, del más reciente al más antiguo. Reabrir uno lo sube al frente;
 * los que quedan fuera del límite se devuelven en `evicted` para desconectar al usuario de ellos.
 * @template {{ docRef: string }} T
 * @param {T[]} openDocs
 * @param {T} opened
 * @param {number} limit
 * @returns {{ open: T[], evicted: T[] }}
 */
function trackOpenDocument(openDocs, opened, limit) {
  const others = openDocs.filter((doc) => doc.docRef !== opened.docRef);
  return { open: [opened, ...others].slice(0, limit), evicted: others.slice(limit - 1) };
}

module.exports = { trackOpenDocument };
