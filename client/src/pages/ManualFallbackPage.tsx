import { useState, useEffect, useCallback, useMemo } from 'react';
import type { ProductCatalogEntry, QuoteTemplate, ErrorResponse, JobberReadMeta } from 'shared';
import {
  fetchCatalogResult,
  saveCatalog,
  fetchTemplates,
  saveTemplates,
  checkJobberStatus,
} from '../api';

interface CatalogFormEntry {
  name: string;
  unitPrice: string;
  description: string;
}

const emptyCatalogEntry: CatalogFormEntry = { name: '', unitPrice: '', description: '' };

interface TemplateFormEntry {
  name: string;
  content: string;
}

const emptyTemplateEntry: TemplateFormEntry = { name: '', content: '' };

export default function ManualFallbackPage() {
  // Catalog state
  const [catalogEntries, setCatalogEntries] = useState<ProductCatalogEntry[]>([]);
  const [newProduct, setNewProduct] = useState<CatalogFormEntry>({ ...emptyCatalogEntry });
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [editProduct, setEditProduct] = useState<CatalogFormEntry>({ ...emptyCatalogEntry });

  // Template state
  const [templateEntries, setTemplateEntries] = useState<QuoteTemplate[]>([]);
  const [newTemplate, setNewTemplate] = useState<TemplateFormEntry>({ ...emptyTemplateEntry });

  // General state
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [jobberAvailable, setJobberAvailable] = useState(false);
  const [jobberRead, setJobberRead] = useState<JobberReadMeta | null>(null);

  // Pagination & search state
  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogPage, setCatalogPage] = useState(1);
  const ITEMS_PER_PAGE = 20;

  const filteredCatalog = useMemo(() => {
    if (!catalogSearch.trim()) return catalogEntries;
    const q = catalogSearch.toLowerCase();
    return catalogEntries.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        (e.category && e.category.toLowerCase().includes(q)),
    );
  }, [catalogEntries, catalogSearch]);

  const totalPages = Math.max(1, Math.ceil(filteredCatalog.length / ITEMS_PER_PAGE));

  // Clamp page when total pages decrease (e.g., after deleting items)
  useEffect(() => {
    if (catalogPage > totalPages) setCatalogPage(totalPages);
  }, [catalogPage, totalPages]);

  const paginatedCatalog = filteredCatalog.slice(
    (catalogPage - 1) * ITEMS_PER_PAGE,
    catalogPage * ITEMS_PER_PAGE,
  );

  // Reset to page 1 when search changes
  useEffect(() => { setCatalogPage(1); }, [catalogSearch]);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [catalogRes, templatesRes, statusRes] = await Promise.all([
        fetchCatalogResult(),
        fetchTemplates(),
        checkJobberStatus(),
      ]);
      setCatalogEntries(catalogRes.catalog);
      setTemplateEntries(templatesRes);
      const catalogBad = catalogRes.jobber?.liveLookupFailed || catalogRes.jobber?.status === 'failed';
      const statusBad = statusRes.read?.liveLookupFailed || statusRes.read?.status === 'failed';
      const read = catalogBad ? catalogRes.jobber : statusBad ? statusRes.read : (catalogRes.jobber ?? statusRes.read);
      setJobberRead(read);
      setJobberAvailable(statusRes.available && read.status !== 'failed' && !read.liveLookupFailed);
    } catch (err) {
      setError((err as ErrorResponse).message ?? 'Failed to load data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Poll Jobber status every 30s
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const status = await checkJobberStatus();
        setJobberAvailable(status.available);
        if (status.read.liveLookupFailed || status.read.status === 'failed') {
          setJobberRead(status.read);
        } else if (status.available) {
          setJobberRead(status.read);
        }
      } catch { /* ignore */ }
    }, 30_000);
    return () => clearInterval(interval);
  }, []);

  const clearMessages = () => { setError(null); setSuccessMsg(null); };

  // ── Catalog CRUD ──

  const handleAddProduct = async () => {
    clearMessages();
    if (!newProduct.name.trim() || !newProduct.unitPrice.trim()) {
      setError('Product name and unit price are required.');
      return;
    }
    const price = parseFloat(newProduct.unitPrice);
    if (isNaN(price) || price < 0) {
      setError('Unit price must be a valid non-negative number.');
      return;
    }

    const updated = [
      ...catalogEntries,
      {
        id: 'temp-' + Date.now(),
        name: newProduct.name.trim(),
        unitPrice: price,
        description: newProduct.description.trim(),
        source: 'manual' as const,
      },
    ];

    await persistCatalog(updated);
    setNewProduct({ ...emptyCatalogEntry });
  };

  const handleEditProduct = (entry: ProductCatalogEntry) => {
    setEditingProductId(entry.id);
    setEditProduct({
      name: entry.name,
      unitPrice: String(entry.unitPrice),
      description: entry.description,
    });
  };

  const handleSaveEdit = async () => {
    clearMessages();
    if (!editProduct.name.trim() || !editProduct.unitPrice.trim()) {
      setError('Product name and unit price are required.');
      return;
    }
    const price = parseFloat(editProduct.unitPrice);
    if (isNaN(price) || price < 0) {
      setError('Unit price must be a valid non-negative number.');
      return;
    }

    const updated = catalogEntries.map((e) =>
      e.id === editingProductId
        ? { ...e, name: editProduct.name.trim(), unitPrice: price, description: editProduct.description.trim() }
        : e,
    );

    await persistCatalog(updated);
    setEditingProductId(null);
  };

  const handleRemoveProduct = async (id: string) => {
    clearMessages();
    const updated = catalogEntries.filter((e) => e.id !== id);
    await persistCatalog(updated);
  };

  const persistCatalog = async (entries: ProductCatalogEntry[]) => {
    try {
      setSaving(true);
      const saved = await saveCatalog(
        entries.map((e) => ({ name: e.name, unitPrice: e.unitPrice, description: e.description, category: e.category })),
      );
      setCatalogEntries(saved);
      setSuccessMsg('Catalog saved.');
      setTimeout(() => setSuccessMsg(null), 2000);
    } catch (err) {
      setError((err as ErrorResponse).message ?? 'Failed to save catalog.');
    } finally {
      setSaving(false);
    }
  };

  // ── Template CRUD ──

  const handleAddTemplate = async () => {
    clearMessages();
    if (!newTemplate.name.trim() || !newTemplate.content.trim()) {
      setError('Template name and content are required.');
      return;
    }

    const updated = [
      ...templateEntries,
      {
        id: 'temp-' + Date.now(),
        name: newTemplate.name.trim(),
        content: newTemplate.content.trim(),
        lineItems: [],
        source: 'manual' as const,
      },
    ];

    await persistTemplates(updated);
    setNewTemplate({ ...emptyTemplateEntry });
  };

  const handleRemoveTemplate = async (id: string) => {
    clearMessages();
    const updated = templateEntries.filter((t) => t.id !== id);
    await persistTemplates(updated);
  };

  const persistTemplates = async (entries: QuoteTemplate[]) => {
    try {
      setSaving(true);
      const saved = await saveTemplates(
        entries.map((t) => ({ name: t.name, content: t.content, category: t.category, lineItems: t.lineItems })),
      );
      setTemplateEntries(saved);
      setSuccessMsg('Templates saved.');
      setTimeout(() => setSuccessMsg(null), 2000);
    } catch (err) {
      setError((err as ErrorResponse).message ?? 'Failed to save templates.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={containerStyle}>
        <div style={loadingContainerStyle}>
          <span style={spinnerStyle} />
          <p style={{ margin: '0.75rem 0 0', color: '#555' }}>Loading catalog data…</p>
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <h1 style={titleStyle}>Manual Catalog &amp; Templates</h1>

      {/* Jobber availability banner */}
      {jobberRead && (jobberRead.liveLookupFailed || jobberRead.status === 'failed') && (
        <div style={jobberProblemStyle} role="alert">
          <span>Jobber could not be reached. The products below are your saved catalog.</span>
          <span>Connection failed</span>
        </div>
      )}
      {jobberAvailable && jobberRead?.status !== 'failed' && !jobberRead?.liveLookupFailed && (
        <div style={jobberBannerStyle} role="status">
          <span>
            {jobberRead?.status === 'empty'
              ? 'Jobber returned no products. The list below is your saved catalog.'
              : jobberRead?.status === 'cached'
                ? 'Showing your saved catalog from the last Jobber check.'
                : 'Jobber is connected. New products can be pulled in from Jobber. Templates stay on this computer.'}
          </span>
          <span>{jobberRead?.status === 'cached' ? 'Saved copy' : 'Connected'}</span>
        </div>
      )}

      {error && <div role="alert" style={alertStyle}>{error}</div>}
      {successMsg && <div role="status" style={successStyle}>{successMsg}</div>}

      {/* ── Product Catalog Section ── */}
      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>Product Catalog</h2>

        {/* Search */}
        <input
          type="text"
          placeholder="Search products…"
          value={catalogSearch}
          onChange={(e) => setCatalogSearch(e.target.value)}
          style={{ ...inputStyle, width: '100%', marginBottom: '0.75rem', boxSizing: 'border-box' }}
          aria-label="Search products"
        />

        {/* Add product form */}
        <div style={formRowStyle}>
          <input
            type="text"
            placeholder="Product name"
            value={newProduct.name}
            onChange={(e) => setNewProduct((p) => ({ ...p, name: e.target.value }))}
            style={{ ...inputStyle, flex: 2 }}
            disabled={saving}
            aria-label="New product name"
          />
          <input
            type="number"
            placeholder="Unit price"
            value={newProduct.unitPrice}
            onChange={(e) => setNewProduct((p) => ({ ...p, unitPrice: e.target.value }))}
            style={{ ...inputStyle, flex: 1 }}
            min="0"
            step="0.01"
            disabled={saving}
            aria-label="New product unit price"
          />
          <input
            type="text"
            placeholder="Description (optional)"
            value={newProduct.description}
            onChange={(e) => setNewProduct((p) => ({ ...p, description: e.target.value }))}
            style={{ ...inputStyle, flex: 2 }}
            disabled={saving}
            aria-label="New product description"
          />
          <button onClick={handleAddProduct} disabled={saving} style={addBtnStyle} type="button">
            Add
          </button>
        </div>

        {/* Product list */}
        {filteredCatalog.length === 0 ? (
          <p style={{ color: '#888', fontSize: '0.85rem', margin: '0.5rem 0 0' }}>
            {catalogSearch.trim() ? 'No products match your search.' : 'No products in the manual catalog.'}
          </p>
        ) : (
          <div style={{ marginTop: '0.75rem' }}>
            <p style={{ color: '#888', fontSize: '0.8rem', margin: '0 0 0.5rem' }}>
              Showing {(catalogPage - 1) * ITEMS_PER_PAGE + 1}–{Math.min(catalogPage * ITEMS_PER_PAGE, filteredCatalog.length)} of {filteredCatalog.length} products
            </p>
            {paginatedCatalog.map((entry) => (
              <div key={entry.id} style={itemRowStyle}>
                {editingProductId === entry.id ? (
                  <>
                    <input
                      type="text"
                      value={editProduct.name}
                      onChange={(e) => setEditProduct((p) => ({ ...p, name: e.target.value }))}
                      style={{ ...inputStyle, flex: 2 }}
                      aria-label="Edit product name"
                    />
                    <input
                      type="number"
                      value={editProduct.unitPrice}
                      onChange={(e) => setEditProduct((p) => ({ ...p, unitPrice: e.target.value }))}
                      style={{ ...inputStyle, flex: 1 }}
                      min="0"
                      step="0.01"
                      aria-label="Edit product unit price"
                    />
                    <input
                      type="text"
                      value={editProduct.description}
                      onChange={(e) => setEditProduct((p) => ({ ...p, description: e.target.value }))}
                      style={{ ...inputStyle, flex: 2 }}
                      aria-label="Edit product description"
                    />
                    <button onClick={handleSaveEdit} style={saveBtnStyle} type="button">Save</button>
                    <button onClick={() => setEditingProductId(null)} style={cancelBtnStyle} type="button">Cancel</button>
                  </>
                ) : (
                  <>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontWeight: 500 }}>{entry.name}</span>
                      <span style={{ color: '#888', marginLeft: '0.5rem' }}>${entry.unitPrice.toFixed(2)}</span>
                      {entry.description && (
                        <span style={{ color: '#aaa', marginLeft: '0.5rem', fontSize: '0.85rem' }}>— {entry.description}</span>
                      )}
                    </div>
                    <button onClick={() => handleEditProduct(entry)} style={editBtnStyle} type="button" aria-label={`Edit ${entry.name}`}>✏️</button>
                    <button onClick={() => handleRemoveProduct(entry.id)} style={removeBtnStyle} type="button" aria-label={`Remove ${entry.name}`}>🗑</button>
                  </>
                )}
              </div>
            ))}

            {/* Pagination controls */}
            {totalPages > 1 && (
              <div style={paginationStyle} role="navigation" aria-label="Product catalog pagination">
                <button
                  onClick={() => setCatalogPage((p) => Math.max(1, p - 1))}
                  disabled={catalogPage === 1}
                  style={pageBtnStyle}
                  type="button"
                  aria-label="Previous page"
                >
                  ← Prev
                </button>
                <span style={{ fontSize: '0.85rem', color: '#555' }}>
                  Page {catalogPage} of {totalPages}
                </span>
                <button
                  onClick={() => setCatalogPage((p) => Math.min(totalPages, p + 1))}
                  disabled={catalogPage === totalPages}
                  style={pageBtnStyle}
                  type="button"
                  aria-label="Next page"
                >
                  Next →
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      {/* ── Template Library Section ── */}
      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>Quote Templates</h2>

        {/* Templates are managed manually — Jobber doesn't expose templates via API */}
        <div style={{ marginBottom: '0.75rem' }}>
          <input
            type="text"
            placeholder="Template name"
            value={newTemplate.name}
            onChange={(e) => setNewTemplate((t) => ({ ...t, name: e.target.value }))}
            style={{ ...inputStyle, width: '100%', marginBottom: '0.5rem', boxSizing: 'border-box' }}
            disabled={saving}
            aria-label="New template name"
          />
          <textarea
            placeholder="Paste or type template content…"
            value={newTemplate.content}
            onChange={(e) => setNewTemplate((t) => ({ ...t, content: e.target.value }))}
            rows={4}
            style={textareaStyle}
            disabled={saving}
            aria-label="New template content"
          />
          <button onClick={handleAddTemplate} disabled={saving} style={{ ...addBtnStyle, marginTop: '0.5rem' }} type="button">
            Add Template
          </button>
        </div>

        {templateEntries.length === 0 ? (
          <p style={{ color: '#888', fontSize: '0.85rem', margin: 0 }}>No templates yet. Add templates above to use as starting points for quotes.</p>
        ) : (
          <div>
            {templateEntries.map((tmpl) => (
              <div key={tmpl.id} style={itemRowStyle}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500, marginBottom: '0.25rem' }}>{tmpl.name}</div>
                  <pre style={templatePreviewStyle}>
                    {tmpl.content.length > 200 ? tmpl.content.slice(0, 200) + '…' : tmpl.content}
                  </pre>
                </div>
                <button onClick={() => handleRemoveTemplate(tmpl.id)} style={removeBtnStyle} type="button" aria-label={`Remove template ${tmpl.name}`}>🗑</button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}


// ── Styles ──

const containerStyle: React.CSSProperties = { maxWidth: 800, margin: '0 auto' };
const titleStyle: React.CSSProperties = { margin: '0 0 1.25rem', fontSize: '1.5rem' };

const loadingContainerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '3rem 0',
};

const spinnerStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 28,
  height: 28,
  border: '3px solid #e0e0e0',
  borderTopColor: '#00a89d',
  borderRadius: '50%',
  animation: 'spin 0.6s linear infinite',
};

const alertStyle: React.CSSProperties = {
  background: '#fdecea',
  color: '#611a15',
  padding: '0.75rem 1rem',
  borderRadius: 4,
  marginBottom: '1rem',
};

const successStyle: React.CSSProperties = {
  background: '#e0f7f5',
  color: '#00a89d',
  padding: '0.75rem 1rem',
  borderRadius: 4,
  marginBottom: '1rem',
};

const jobberBannerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '1rem',
  flexWrap: 'wrap',
  background: '#e0f7f5',
  color: '#00a89d',
  padding: '0.75rem 1rem',
  borderRadius: 6,
  marginBottom: '1.25rem',
  fontSize: '0.9rem',
};

const jobberProblemStyle: React.CSSProperties = {
  ...jobberBannerStyle,
  background: '#fdecea',
  color: '#611a15',
};

const sectionStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #e0e0e0',
  borderRadius: 8,
  padding: '1rem 1.25rem',
  marginBottom: '1.25rem',
};

const sectionTitleStyle: React.CSSProperties = {
  margin: '0 0 0.75rem',
  fontSize: '1.1rem',
  fontWeight: 600,
};

const formRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: '0.5rem',
  alignItems: 'center',
  flexWrap: 'wrap',
};

const inputStyle: React.CSSProperties = {
  padding: '0.4rem 0.5rem',
  border: '1px solid #ccc',
  borderRadius: 4,
  fontSize: '0.85rem',
};

const textareaStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '0.5rem',
  border: '1px solid #ccc',
  borderRadius: 4,
  fontSize: '0.85rem',
  boxSizing: 'border-box' as const,
  resize: 'vertical',
  fontFamily: 'inherit',
};

const addBtnStyle: React.CSSProperties = {
  padding: '0.4rem 0.75rem',
  border: '1px solid #00a89d',
  background: '#00a89d',
  color: '#fff',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: '0.85rem',
  whiteSpace: 'nowrap',
};

const itemRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  padding: '0.5rem 0',
  borderBottom: '1px solid #f0f0f0',
};

const editBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  fontSize: '0.9rem',
  padding: '0.25rem',
};

const removeBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  fontSize: '0.9rem',
  padding: '0.25rem',
  color: '#888',
};

const saveBtnStyle: React.CSSProperties = {
  padding: '0.3rem 0.6rem',
  border: '1px solid #00a89d',
  background: '#00a89d',
  color: '#fff',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: '0.8rem',
};

const cancelBtnStyle: React.CSSProperties = {
  padding: '0.3rem 0.6rem',
  border: '1px solid #888',
  background: 'transparent',
  color: '#888',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: '0.8rem',
};

const templatePreviewStyle: React.CSSProperties = {
  margin: 0,
  fontSize: '0.8rem',
  color: '#666',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  background: '#fafafa',
  padding: '0.4rem',
  borderRadius: 4,
  maxHeight: 80,
  overflow: 'hidden',
};

const paginationStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '1rem',
  marginTop: '0.75rem',
  paddingTop: '0.75rem',
  borderTop: '1px solid #e0e0e0',
};

const pageBtnStyle: React.CSSProperties = {
  padding: '0.35rem 0.75rem',
  border: '1px solid #ccc',
  background: '#fff',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: '0.8rem',
  color: '#333',
};
