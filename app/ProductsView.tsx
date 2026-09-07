"use client";
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from "react";

type Product = {
  id: number;
  tag: string;
  name: string;
  reference: string | null;
  price: number;
  brand: string | null;
  needsReview: boolean;
  supplierId: number | null;
  supplierName: string | null;
  equipmentModelId: number | null;
  applicationName: string | null;
};
type Supplier = { id: number; name: string; active: boolean };
type EquipmentModel = { id: number; name: string; manufacturer: string | null; category: string | null; active: boolean };
type ProductsResponse = { products: Product[]; total: number; page: number; pageSize: number; availableBrands: string[] };
type User = { profile: string; permissions: string[] };
type ImportSummary = {
  totalRead: number;
  skippedGarbage: number;
  inserted: number;
  updated: number;
  linkedToModel: number;
  markedNeedsReview: number;
  unmatchedApplications: Array<{ application: string; occurrences: number }>;
};

const PAGE_SIZE = 50;
const priceFormat = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const can = (user: User, permission: string) => user.permissions.includes(permission);

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error ?? "A operação não pôde ser concluída."));
  return data as T;
}

const COLUMNS: Array<[string, string]> = [
  ["tag", "TAG"],
  ["name", "Nome"],
  ["reference", "Referência"],
  ["price", "Preço"],
  ["supplier", "Fornecedor"],
  ["brand", "Marca"],
  ["application", "Aplicação"],
];

export default function ProductsView({ authUser, flash }: { authUser: User; flash: (message: string) => void }) {
  const [data, setData] = useState<ProductsResponse>({ products: [], total: 0, page: 1, pageSize: PAGE_SIZE, availableBrands: [] });
  const [models, setModels] = useState<EquipmentModel[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [applicationFilter, setApplicationFilter] = useState("TODAS");
  const [supplierFilter, setSupplierFilter] = useState("TODOS");
  const [brandFilter, setBrandFilter] = useState("TODAS");
  const [onlyReview, setOnlyReview] = useState(false);
  const [sortBy, setSortBy] = useState("tag");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Product | null | "new">(null);
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 300);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    setPage(1);
  }, [debouncedQuery, applicationFilter, supplierFilter, brandFilter, onlyReview]);

  const filterParams = useCallback(() => {
    const params = new URLSearchParams();
    if (debouncedQuery) params.set("q", debouncedQuery);
    if (applicationFilter !== "TODAS") params.set("equipmentModelId", applicationFilter);
    if (supplierFilter !== "TODOS") params.set("supplierId", supplierFilter);
    if (brandFilter !== "TODAS") params.set("brand", brandFilter);
    if (onlyReview) params.set("needsReview", "1");
    return params;
  }, [debouncedQuery, applicationFilter, supplierFilter, brandFilter, onlyReview]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const params = filterParams();
    params.set("page", String(page));
    params.set("pageSize", String(PAGE_SIZE));
    params.set("sortBy", sortBy);
    params.set("sortDir", sortDir);
    try {
      setData(await fetchJson<ProductsResponse>(`/api/products?${params.toString()}`));
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Não foi possível carregar os produtos.");
    } finally {
      setLoading(false);
    }
  }, [filterParams, page, sortBy, sortDir]);

  useEffect(() => {
    load();
  }, [load]);

  const loadModels = useCallback(() => {
    fetchJson<{ models: EquipmentModel[] }>("/api/equipment-models?includeInactive=1")
      .then((result) => setModels(result.models))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    loadModels();
    fetchJson<{ suppliers: Supplier[] }>("/api/suppliers?includeInactive=1")
      .then((result) => setSuppliers(result.suppliers))
      .catch(() => undefined);
  }, [loadModels]);

  function toggleSort(key: string) {
    if (sortBy === key) setSortDir((current) => (current === "asc" ? "desc" : "asc"));
    else {
      setSortBy(key);
      setSortDir("asc");
    }
  }

  function exportUrl(kind: "csv" | "pdf") {
    return `/api/products-${kind}?${filterParams().toString()}`;
  }

  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const activeModels = models.filter((model) => model.active);
  const canEdit = can(authUser, "products.edit");

  return (
    <>
      <div className="page-heading module-heading">
        <div>
          <p className="eyebrow">MÓDULO PRODUTOS</p>
          <h1>Produtos</h1>
          <span>Peças, insumos, EPI e mantimentos — {data.total.toLocaleString("pt-BR")} cadastrados.</span>
        </div>
        <div className="heading-actions">
          {can(authUser, "products.import") && (
            <button className="secondary" onClick={() => setImportOpen(true)}>
              Importar CSV
            </button>
          )}
          <a className="secondary" href={exportUrl("csv")}>
            Exportar CSV
          </a>
          <a className="secondary" href={exportUrl("pdf")} target="_blank" rel="noopener noreferrer">
            Exportar PDF
          </a>
          {can(authUser, "products.create") && (
            <button className="primary" onClick={() => setEditing("new")}>
              ＋ Novo produto
            </button>
          )}
        </div>
      </div>
      <article className="panel module-panel products-panel">
        <div className="products-filters">
          <label className="page-search">
            <span>⌕</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por TAG, nome ou referência..." />
          </label>
          <label>
            Aplicação
            <select value={applicationFilter} onChange={(event) => setApplicationFilter(event.target.value)}>
              <option value="TODAS">Todas</option>
              <option value="none">Uso geral (sem aplicação)</option>
              {activeModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Fornecedor
            <select value={supplierFilter} onChange={(event) => setSupplierFilter(event.target.value)}>
              <option value="TODOS">Todos</option>
              {suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Marca
            <select value={brandFilter} onChange={(event) => setBrandFilter(event.target.value)}>
              <option value="TODAS">Todas</option>
              {data.availableBrands.map((brand) => (
                <option key={brand}>{brand}</option>
              ))}
            </select>
          </label>
          <label className="products-review-toggle">
            <input type="checkbox" checked={onlyReview} onChange={(event) => setOnlyReview(event.target.checked)} />
            <strong>Somente pendentes de revisão</strong>
          </label>
        </div>
        {error && (
          <div className="operation-error">
            <span>!</span>
            <div>
              <strong>Falha ao carregar</strong>
              <p>{error}</p>
            </div>
            <button onClick={load}>Tentar novamente</button>
          </div>
        )}
        {loading ? (
          <div className="page-loading">
            <span />
            <p>Carregando produtos...</p>
          </div>
        ) : (
          <>
            <div className="table-scroll">
              <table className="products-table">
                <thead>
                  <tr>
                    {COLUMNS.map(([key, label]) => (
                      <th key={key}>
                        <button onClick={() => toggleSort(key)}>
                          {label}
                          {sortBy === key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                        </button>
                      </th>
                    ))}
                    <th>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {data.products.map((product) => (
                    <tr key={product.id}>
                      <td className="tag-cell">
                        {product.tag}
                        {product.needsReview && <span className="products-review-badge">Revisar</span>}
                      </td>
                      <td>{product.name}</td>
                      <td>{product.reference ?? "—"}</td>
                      <td className="price-cell">{priceFormat.format(product.price)}</td>
                      <td>{product.supplierName ?? "—"}</td>
                      <td>{product.brand ?? "—"}</td>
                      <td>{product.applicationName ?? "Uso geral"}</td>
                      <td>
                        <div className="equipment-row-actions">
                          <button onClick={() => setEditing(product)}>{canEdit ? "Editar" : "Ver"}</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.products.length === 0 && <div className="empty-state">Nenhum produto corresponde aos filtros.</div>}
            </div>
            <div className="pagination-bar">
              <span>
                Página {data.page} de {totalPages} · {data.total.toLocaleString("pt-BR")} produtos
              </span>
              <div className="pagination-controls">
                <button disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
                  ‹ Anterior
                </button>
                <button disabled={page >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>
                  Próxima ›
                </button>
              </div>
            </div>
          </>
        )}
      </article>
      {can(authUser, "products.manage_models") && <EquipmentModelManager models={models} reload={loadModels} />}
      {editing && (
        <ProductModal
          item={editing === "new" ? null : editing}
          models={activeModels}
          suppliers={suppliers}
          readOnly={!canEdit}
          close={() => setEditing(null)}
          saved={async (message) => {
            setEditing(null);
            await load();
            flash(message);
          }}
          onSupplierCreated={(supplier) => setSuppliers((current) => [...current, supplier].sort((a, b) => a.name.localeCompare(b.name, "pt-BR")))}
        />
      )}
      {importOpen && (
        <ImportCsvModal
          close={() => setImportOpen(false)}
          imported={async (message) => {
            setImportOpen(false);
            await load();
            flash(message);
          }}
        />
      )}
    </>
  );
}

function EquipmentModelManager({ models, reload }: { models: EquipmentModel[]; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await fetchJson("/api/equipment-models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, manufacturer, category }) });
      setName("");
      setManufacturer("");
      setCategory("");
      reload();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Não foi possível cadastrar o modelo.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(model: EquipmentModel) {
    try {
      await fetchJson(`/api/equipment-models/${model.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active: !model.active }) });
      reload();
    } catch {
      /* silencioso: o item volta ao estado anterior no próximo reload */
    }
  }

  return (
    <details className="equipment-model-manager" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Gerenciar modelos de equipamento (Aplicação) · {models.length} cadastrados</summary>
      <form className="equipment-model-manager-row" onSubmit={create}>
        <input required placeholder="Nome (ex.: MB AXOR 3344)" value={name} onChange={(event) => setName(event.target.value)} />
        <input placeholder="Fabricante" value={manufacturer} onChange={(event) => setManufacturer(event.target.value)} />
        <input placeholder="Categoria" value={category} onChange={(event) => setCategory(event.target.value)} />
        <button className="primary" disabled={busy}>
          {busy ? "Salvando..." : "＋ Adicionar"}
        </button>
      </form>
      {error && (
        <div className="operation-error">
          <span>!</span>
          <div>
            <strong>Falha</strong>
            <p>{error}</p>
          </div>
        </div>
      )}
      <div className="equipment-model-manager-list">
        {models.map((model) => (
          <div className="equipment-model-manager-row" key={model.id}>
            <strong>{model.name}</strong>
            <span>{model.manufacturer ?? "—"}</span>
            <span>{model.category ?? "—"}</span>
            <button onClick={() => toggleActive(model)}>{model.active ? "Desativar" : "Reativar"}</button>
          </div>
        ))}
      </div>
    </details>
  );
}

function ProductModal({
  item,
  models,
  suppliers,
  readOnly,
  close,
  saved,
  onSupplierCreated,
}: {
  item: Product | null;
  models: EquipmentModel[];
  suppliers: Supplier[];
  readOnly: boolean;
  close: () => void;
  saved: (message: string) => Promise<void>;
  onSupplierCreated: (supplier: Supplier) => void;
}) {
  const [supplierId, setSupplierId] = useState(item?.supplierId ? String(item.supplierId) : "");
  const [equipmentModelId, setEquipmentModelId] = useState(item?.equipmentModelId ? String(item.equipmentModelId) : "");
  const [needsReview, setNeedsReview] = useState(item?.needsReview ?? false);
  const [newSupplierOpen, setNewSupplierOpen] = useState(false);
  const [newSupplierName, setNewSupplierName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function createSupplier() {
    if (!newSupplierName.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await fetchJson<{ supplier: Supplier }>("/api/suppliers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newSupplierName.trim() }),
      });
      onSupplierCreated(result.supplier);
      setSupplierId(String(result.supplier.id));
      setNewSupplierOpen(false);
      setNewSupplierName("");
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Não foi possível cadastrar o fornecedor.");
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const payload = {
      tag: form.get("tag"),
      name: form.get("name"),
      reference: form.get("reference"),
      price: form.get("price"),
      brand: form.get("brand"),
      supplierId: supplierId || null,
      equipmentModelId: equipmentModelId || null,
      needsReview,
    };
    try {
      await fetchJson(item ? `/api/products/${item.id}` : "/api/products", {
        method: item ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      await saved(item ? "Produto atualizado com sucesso." : "Produto cadastrado com sucesso.");
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Não foi possível salvar o produto.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="modal product-form-modal">
        <header>
          <div>
            <p className="eyebrow">PRODUTOS</p>
            <h2>{readOnly ? "Detalhes do produto" : item ? "Editar produto" : "Cadastrar produto"}</h2>
            <span>TAG única, nome e referência sempre gravados em maiúsculas.</span>
          </div>
          <button onClick={close}>×</button>
        </header>
        <form className="modal-form" onSubmit={submit}>
          <label>
            TAG
            <input name="tag" required defaultValue={item?.tag} disabled={readOnly} />
          </label>
          <label>
            Nome
            <input name="name" required defaultValue={item?.name} disabled={readOnly} style={{ textTransform: "uppercase" }} />
          </label>
          <label>
            Referência
            <input name="reference" defaultValue={item?.reference ?? ""} disabled={readOnly} style={{ textTransform: "uppercase" }} />
          </label>
          <label>
            Preço
            <input name="price" required inputMode="decimal" defaultValue={item ? String(item.price).replace(".", ",") : "0"} disabled={readOnly} />
          </label>
          <label className="full">
            Fornecedor
            <select value={supplierId} onChange={(event) => setSupplierId(event.target.value)} disabled={readOnly}>
              <option value="">— Nenhum —</option>
              {suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </select>
            {!readOnly && !newSupplierOpen && (
              <button type="button" className="link-button" onClick={() => setNewSupplierOpen(true)}>
                + Cadastrar novo fornecedor
              </button>
            )}
            {!readOnly && newSupplierOpen && (
              <div className="combo-with-create">
                <input placeholder="Nome do novo fornecedor" value={newSupplierName} onChange={(event) => setNewSupplierName(event.target.value)} />
                <button type="button" disabled={busy} onClick={createSupplier}>
                  Salvar
                </button>
              </div>
            )}
          </label>
          <label>
            Marca
            <input name="brand" defaultValue={item?.brand ?? ""} disabled={readOnly} />
          </label>
          <label>
            Aplicação
            <select value={equipmentModelId} onChange={(event) => setEquipmentModelId(event.target.value)} disabled={readOnly}>
              <option value="">Nenhuma / uso geral</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
          </label>
          {item && (
            <label className="full products-review-toggle">
              <input type="checkbox" checked={needsReview} onChange={(event) => setNeedsReview(event.target.checked)} disabled={readOnly} />
              <strong>Marcado para revisão</strong>
            </label>
          )}
          {error && (
            <div className="equipment-form-error full">
              <span>!</span>
              <strong>{error}</strong>
            </div>
          )}
          <div className="modal-footer full">
            <button type="button" className="secondary" onClick={close}>
              {readOnly ? "Fechar" : "Cancelar"}
            </button>
            {!readOnly && (
              <button className="primary" disabled={busy}>
                {busy ? "Salvando..." : "Salvar produto"}
              </button>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}

function ImportCsvModal({ close, imported }: { close: () => void; imported: (message: string) => Promise<void> }) {
  const [fileName, setFileName] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  function pickFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setError("");
    const reader = new FileReader();
    reader.onload = () => setContent(String(reader.result ?? ""));
    reader.readAsText(file, "utf-8");
  }

  async function run() {
    if (!content) {
      setError("Selecione o arquivo CSV.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await fetchJson<ImportSummary>("/api/products/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ csv: content }) });
      setSummary(result);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Não foi possível importar o arquivo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="modal">
        <header>
          <div>
            <p className="eyebrow">PRODUTOS</p>
            <h2>Importar CSV</h2>
            <span>Cabeçalho esperado: tag;nome;referencia;preco;fornecedor;marca;aplicacao. Upsert por TAG — importar de novo não duplica.</span>
          </div>
          <button onClick={close}>×</button>
        </header>
        {!summary ? (
          <div className="modal-form">
            <label className="import-file-picker full">
              <input type="file" accept=".csv" onChange={pickFile} />
              <span>{fileName || "Escolher arquivo CSV..."}</span>
              <b>Selecionar</b>
            </label>
            {error && (
              <div className="equipment-form-error full">
                <span>!</span>
                <strong>{error}</strong>
              </div>
            )}
            <div className="modal-footer full">
              <button type="button" className="secondary" onClick={close}>
                Cancelar
              </button>
              <button className="primary" disabled={busy || !content} onClick={run}>
                {busy ? "Importando..." : "Importar"}
              </button>
            </div>
          </div>
        ) : (
          <div className="modal-form">
            <div className="import-summary full">
              <p>
                <span>Lidos</span>
                <strong>{summary.totalRead}</strong>
              </p>
              <p className="ready">
                <span>Inseridos</span>
                <strong>{summary.inserted}</strong>
              </p>
              <p className="ready">
                <span>Atualizados</span>
                <strong>{summary.updated}</strong>
              </p>
              <p>
                <span>Vinculados a modelo</span>
                <strong>{summary.linkedToModel}</strong>
              </p>
              <p className="warning">
                <span>P/ revisão</span>
                <strong>{summary.markedNeedsReview}</strong>
              </p>
            </div>
            {summary.skippedGarbage > 0 && <p>{summary.skippedGarbage} linha(s) ignorada(s) por não trazer TAG válida.</p>}
            {summary.unmatchedApplications.length > 0 && (
              <div className="full">
                <strong>Aplicações que não casaram com nenhum modelo:</strong>
                <ul>
                  {summary.unmatchedApplications.map((entry) => (
                    <li key={entry.application}>
                      {entry.application} ({entry.occurrences}x)
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="modal-footer full">
              <button className="primary" onClick={() => imported(`Importação concluída: ${summary.inserted} inseridos, ${summary.updated} atualizados.`)}>
                Concluir
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
