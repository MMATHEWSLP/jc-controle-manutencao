"use client";
/* eslint-disable react-hooks/set-state-in-effect */
/* eslint-disable @next/next/no-img-element -- fotos vêm de rota própria (já otimizadas em WebP no navegador), como a foto do equipamento */
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import StockMovementsTable, { type StockMovementRow } from "./StockMovementsTable";
import { optimizePhoto } from "../lib/photo-client";

type ProductFront = { serviceFrontId: number; name: string; active: boolean; quantity: number; editable: boolean };
type Product = {
  id: number;
  tag: string;
  name: string;
  reference: string | null;
  references: string[];
  price: number;
  brand: string | null;
  needsReview: boolean;
  supplierId: number | null;
  supplierName: string | null;
  equipmentModelId: number | null;
  equipmentModelIds: number[];
  applicationName: string | null;
  applicationNames: string[];
  photoIds: number[];
  fronts: ProductFront[];
  activeHere: boolean;
  quantityHere: number;
};
type Front = { id: number; name: string };
type Supplier = { id: number; name: string; active: boolean };
type EquipmentModel = { id: number; name: string; manufacturer: string | null; category: string | null; active: boolean };
type Scope = { allFronts: boolean; frontIds: number[]; multiFront: boolean };
type ProductsResponse = { products: Product[]; total: number; page: number; pageSize: number; availableBrands: string[]; scope: Scope; visibleFronts: Front[] };
type SimilarMatch = { id: number; tag: string; name: string; score: number; fronts: Array<{ serviceFrontId: number; name: string }>; activeHere: boolean };
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
const quantityFormat = (value: number) => value.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
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
  const [data, setData] = useState<ProductsResponse>({ products: [], total: 0, page: 1, pageSize: PAGE_SIZE, availableBrands: [], scope: { allFronts: true, frontIds: [], multiFront: false }, visibleFronts: [] });
  const [models, setModels] = useState<EquipmentModel[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [tagQuery, setTagQuery] = useState("");
  const [debouncedTag, setDebouncedTag] = useState("");
  const [applicationFilter, setApplicationFilter] = useState("TODAS");
  const [supplierFilter, setSupplierFilter] = useState("TODOS");
  const [brandFilter, setBrandFilter] = useState("TODAS");
  const [onlyReview, setOnlyReview] = useState(false);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [sortBy, setSortBy] = useState("tag");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Product | null | "new">(null);
  const [importOpen, setImportOpen] = useState(false);
  const [activating, setActivating] = useState<number | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 300);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedTag(tagQuery), 300);
    return () => window.clearTimeout(timer);
  }, [tagQuery]);
  useEffect(() => {
    setPage(1);
  }, [debouncedQuery, debouncedTag, applicationFilter, supplierFilter, brandFilter, onlyReview, includeInactive]);

  const filterParams = useCallback(() => {
    const params = new URLSearchParams();
    if (debouncedQuery) params.set("q", debouncedQuery);
    if (debouncedTag.trim()) params.set("tag", debouncedTag.trim());
    if (applicationFilter !== "TODAS") params.set("equipmentModelId", applicationFilter);
    if (supplierFilter !== "TODOS") params.set("supplierId", supplierFilter);
    if (brandFilter !== "TODAS") params.set("brand", brandFilter);
    if (onlyReview) params.set("needsReview", "1");
    if (includeInactive) params.set("includeInactive", "1");
    return params;
  }, [debouncedQuery, debouncedTag, applicationFilter, supplierFilter, brandFilter, onlyReview, includeInactive]);

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
  const canActivate = can(authUser, "products.create") || canEdit;
  // Frente única em exibição (seletor global ou usuário de uma frente só): é nela que "Ativar" age.
  const singleFront = !data.scope.allFronts && data.scope.frontIds.length === 1 ? data.visibleFronts.find((front) => front.id === data.scope.frontIds[0]) ?? null : null;
  const scopeLabel = data.scope.allFronts ? "todas as frentes" : data.visibleFronts.filter((front) => data.scope.frontIds.includes(front.id)).map((front) => front.name).join(", ");

  async function activate(product: Product, front: Front) {
    setActivating(product.id);
    try {
      const result = await fetchJson<{ message: string }>(`/api/products/${product.id}/fronts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serviceFrontId: front.id, active: true }) });
      await load();
      flash(result.message);
    } catch (problem) {
      flash(problem instanceof Error ? problem.message : "Não foi possível ativar o produto.");
    } finally {
      setActivating(null);
    }
  }

  return (
    <>
      <div className="page-heading module-heading">
        <div>
          <p className="eyebrow">MÓDULO PRODUTOS · {scopeLabel.toUpperCase()}</p>
          <h1>Produtos</h1>
          <span>Peças, insumos, EPI e mantimentos — {data.total.toLocaleString("pt-BR")} {includeInactive || data.scope.allFronts ? "no catálogo" : `ativos em ${scopeLabel}`}.</span>
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
        <div className="products-filters products-filters-two-search">
          <label className="page-search" title="Busca ampla: TAG, nome ou referência (aproximada)">
            <span>⌕</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por TAG, nome ou referência..." />
          </label>
          <label className="page-search products-tag-search" title="Somente o produto com esta TAG exata (sem correspondências parciais)">
            <span>#</span>
            <input value={tagQuery} onChange={(event) => setTagQuery(event.target.value)} placeholder="TAG exata" inputMode="numeric" aria-label="Buscar por TAG exata" />
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
          {!data.scope.allFronts && (
            <label className="products-review-toggle products-inactive-toggle" title="Mostra, apagados, os produtos que existem só em outras frentes — para ativar aqui sem cadastrar de novo">
              <input type="checkbox" checked={includeInactive} onChange={(event) => setIncludeInactive(event.target.checked)} />
              <strong>Mostrar produtos de outras frentes</strong>
            </label>
          )}
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
                    <th aria-label="Foto" />
                    {COLUMNS.map(([key, label]) => (
                      <th key={key}>
                        <button onClick={() => toggleSort(key)}>
                          {label}
                          {sortBy === key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                        </button>
                      </th>
                    ))}
                    <th>Estoque</th>
                    <th>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {data.products.map((product) => {
                    const activeFronts = product.fronts.filter((front) => front.active);
                    const breakdown = data.scope.multiFront && activeFronts.filter((front) => front.editable).length > 1;
                    return (
                      <tr key={product.id} className={product.activeHere ? "" : "product-inactive-here"} title={product.activeHere ? undefined : `Não está ativo em ${scopeLabel}. Ative para dar entrada nesta frente.`}>
                        <td className="product-thumb-cell">
                          {product.photoIds[0] ? <img src={`/api/products/photos/${product.photoIds[0]}`} alt="" loading="lazy" /> : <span aria-hidden>▢</span>}
                        </td>
                        <td className="tag-cell">
                          {product.tag}
                          {product.needsReview && <span className="products-review-badge">Revisar</span>}
                        </td>
                        <td>
                          {product.name}
                          <div className="product-front-badges">
                            {activeFronts.length === 0 ? <span className="product-front-badge none">Inativo em todas as frentes</span> : activeFronts.map((front) => <span key={front.serviceFrontId} className="product-front-badge">{front.name}</span>)}
                          </div>
                        </td>
                        <td>{product.references.length ? product.references.join(" / ") : product.reference ?? "—"}</td>
                        <td className="price-cell">{priceFormat.format(product.price)}</td>
                        <td>{product.supplierName ?? "—"}</td>
                        <td>{product.brand ?? "—"}</td>
                        <td>{product.applicationName ?? "Uso geral"}</td>
                        <td className="product-stock-cell">
                          {product.activeHere ? <strong>{quantityFormat(product.quantityHere)}</strong> : <span>—</span>}
                          {breakdown && <small>{activeFronts.filter((front) => front.editable).map((front) => `${front.name}: ${quantityFormat(front.quantity)}`).join(" / ")}</small>}
                        </td>
                        <td>
                          <div className="equipment-row-actions">
                            {!product.activeHere && canActivate && singleFront && (
                              <button className="product-activate-button" disabled={activating === product.id} onClick={() => activate(product, singleFront)}>
                                {activating === product.id ? "Ativando..." : `Ativar em ${singleFront.name}`}
                              </button>
                            )}
                            <button onClick={() => setEditing(product)}>{canEdit ? "Editar" : "Ver"}</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {data.products.length === 0 && (
                <div className="empty-state">
                  {debouncedTag ? `Nenhum produto com a TAG exata "${debouncedTag}".` : "Nenhum produto corresponde aos filtros."}
                  {!includeInactive && !data.scope.allFronts && <> <button className="link-button" onClick={() => setIncludeInactive(true)}>Procurar também nas outras frentes</button></>}
                </div>
              )}
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
          fronts={data.visibleFronts}
          scope={data.scope}
          authUser={authUser}
          readOnly={editing !== "new" && !canEdit}
          close={() => setEditing(null)}
          openExisting={async (id) => {
            try {
              const result = await fetchJson<{ product: Product }>(`/api/products/${id}`);
              setEditing(result.product);
            } catch (problem) {
              flash(problem instanceof Error ? problem.message : "Não foi possível abrir o produto.");
            }
          }}
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
  fronts,
  scope,
  authUser,
  readOnly,
  close,
  openExisting,
  saved,
  onSupplierCreated,
}: {
  item: Product | null;
  models: EquipmentModel[];
  suppliers: Supplier[];
  fronts: Front[];
  scope: Scope;
  authUser: User;
  readOnly: boolean;
  close: () => void;
  openExisting: (id: number) => Promise<void>;
  saved: (message: string) => Promise<void>;
  onSupplierCreated: (supplier: Supplier) => void;
}) {
  const [tag, setTag] = useState(item?.tag ?? "");
  const [name, setName] = useState(item?.name ?? "");
  const [references, setReferences] = useState<string[]>(item ? (item.references.length ? item.references : item.reference ? [item.reference] : []) : []);
  const [referenceInput, setReferenceInput] = useState("");
  const [supplierId, setSupplierId] = useState(item?.supplierId ? String(item.supplierId) : "");
  const [modelIds, setModelIds] = useState<number[]>(item?.equipmentModelIds ?? (item?.equipmentModelId ? [item.equipmentModelId] : []));
  const [modelFilter, setModelFilter] = useState("");
  const [needsReview, setNeedsReview] = useState(item?.needsReview ?? false);
  const [creationFrontId, setCreationFrontId] = useState(() => (!scope.allFronts && scope.frontIds.length === 1 ? String(scope.frontIds[0]) : fronts.length === 1 ? String(fronts[0].id) : ""));
  const [stockRows, setStockRows] = useState<ProductFront[]>(item?.fronts ?? []);
  const [stockDraft, setStockDraft] = useState<Record<number, string>>({});
  const [photoIds, setPhotoIds] = useState<number[]>(item?.photoIds ?? []);
  const [pendingPhotos, setPendingPhotos] = useState<Array<{ file: File; url: string }>>([]);
  const [similar, setSimilar] = useState<SimilarMatch[]>([]);
  const [similarDismissed, setSimilarDismissed] = useState(false);
  const [newSupplierOpen, setNewSupplierOpen] = useState(false);
  const [newSupplierName, setNewSupplierName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [modalTab, setModalTab] = useState<"dados" | "historico">("dados");
  const fileInput = useRef<HTMLInputElement>(null);
  const canUploadPhotos = !readOnly && (can(authUser, "products.create") || can(authUser, "products.edit"));
  const canActivate = can(authUser, "products.create") || can(authUser, "products.edit");

  // TAG sugerida = próxima da sequência (continua editável; a unicidade é conferida ao salvar).
  useEffect(() => {
    if (item || readOnly) return;
    fetchJson<{ tag: string }>("/api/products/next-tag").then((result) => setTag((current) => current || result.tag)).catch(() => undefined);
  }, [item, readOnly]);

  // Aviso de nome parecido (não bloqueia): compara com o catálogo inteiro enquanto a pessoa digita.
  useEffect(() => {
    if (readOnly || (item && name.trim().toUpperCase() === item.name)) { setSimilar([]); return; }
    const value = name.trim();
    if (value.length < 3) { setSimilar([]); return; }
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ name: value });
      if (item) params.set("excludeId", String(item.id));
      fetchJson<{ matches: SimilarMatch[] }>(`/api/products/similar?${params.toString()}`).then((result) => { setSimilar(result.matches); setSimilarDismissed(false); }).catch(() => setSimilar([]));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [name, item, readOnly]);

  // Libera as prévias locais só ao fechar o modal (descartar uma foto libera a dela na hora).
  const pendingRef = useRef(pendingPhotos);
  useEffect(() => { pendingRef.current = pendingPhotos; }, [pendingPhotos]);
  useEffect(() => () => pendingRef.current.forEach((photo) => URL.revokeObjectURL(photo.url)), []);

  function addReference() {
    const value = referenceInput.trim().toUpperCase();
    if (!value) return;
    const key = value.replace(/[\s./-]/g, "");
    if (references.some((reference) => reference.replace(/[\s./-]/g, "") === key)) { setError(`A referência ${value} já está na lista.`); return; }
    setReferences((current) => [...current, value]);
    setReferenceInput("");
    setError("");
  }

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

  async function toggleFront(front: Front, active: boolean, productId = item?.id) {
    if (!productId) return false;
    setBusy(true);
    setError("");
    try {
      await fetchJson(`/api/products/${productId}/fronts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serviceFrontId: front.id, active }) });
      setStockRows((current) => {
        const existing = current.find((row) => row.serviceFrontId === front.id);
        if (existing) return current.map((row) => (row.serviceFrontId === front.id ? { ...row, active } : row));
        return [...current, { serviceFrontId: front.id, name: front.name, active, quantity: 0, editable: true }];
      });
      return true;
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Não foi possível alterar o produto nesta frente.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function removePhoto(photoId: number) {
    if (!window.confirm("Remover esta foto do produto?")) return;
    try {
      await fetchJson(`/api/products/photos/${photoId}`, { method: "DELETE" });
      setPhotoIds((current) => current.filter((id) => id !== photoId));
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Não foi possível remover a foto.");
    }
  }

  function pickPhotos(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    setPendingPhotos((current) => [...current, ...files.map((file) => ({ file, url: URL.createObjectURL(file) }))]);
  }

  async function uploadPhotos(productId: number) {
    if (pendingPhotos.length === 0) return;
    const form = new FormData();
    for (const photo of pendingPhotos) form.append("files", await optimizePhoto(photo.file), `${photo.file.name.replace(/\.[^.]+$/, "")}.webp`);
    await fetchJson(`/api/products/${productId}/photos`, { method: "POST", body: form });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const pendingReference = referenceInput.trim().toUpperCase();
    const allReferences = pendingReference && !references.includes(pendingReference) ? [...references, pendingReference] : references;
    const stocks = Object.entries(stockDraft).map(([serviceFrontId, quantity]) => ({ serviceFrontId: Number(serviceFrontId), quantity })).filter((entry) => entry.quantity.trim() !== "");
    const payload = {
      tag,
      name,
      references: allReferences,
      price: form.get("price"),
      brand: form.get("brand"),
      supplierId: supplierId || null,
      equipmentModelIds: modelIds,
      needsReview,
      ...(item ? { stocks } : { serviceFrontId: creationFrontId || null }),
    };
    let productId = item?.id ?? null;
    try {
      const result = await fetchJson<{ product: { id: number } }>(item ? `/api/products/${item.id}` : "/api/products", {
        method: item ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      productId = result.product.id;
      await uploadPhotos(productId);
      await saved(item ? "Produto atualizado com sucesso." : "Produto cadastrado com sucesso (estoque inicial zerado).");
    } catch (problem) {
      const message = problem instanceof Error ? problem.message : "Não foi possível salvar o produto.";
      // Produto já foi salvo e só a foto falhou: não pode reenviar o cadastro (duplicaria a TAG).
      if (!item && productId) await saved(`Produto cadastrado, mas as fotos não foram enviadas: ${message}`);
      else setError(message);
    } finally {
      setBusy(false);
    }
  }

  const filteredModels = models.filter((model) => !modelFilter || model.name.toUpperCase().includes(modelFilter.toUpperCase()) || modelIds.includes(model.id));
  const showSimilar = similar.length > 0 && !similarDismissed;
  const singleFront = !scope.allFronts && scope.frontIds.length === 1 ? fronts.find((front) => front.id === scope.frontIds[0]) ?? null : null;

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="modal product-form-modal">
        <header>
          <div>
            <p className="eyebrow">PRODUTOS</p>
            <h2>{readOnly ? "Detalhes do produto" : item ? "Editar produto" : "Cadastrar produto"}</h2>
            <span>TAG única no sistema inteiro, gerada em sequência. Nome e referências sempre em maiúsculas.</span>
          </div>
          <button onClick={close}>×</button>
        </header>
        {item && (
          <div className="main-tabs secondary-module-nav product-modal-tabs" role="tablist">
            <button type="button" className={modalTab === "dados" ? "active" : ""} onClick={() => setModalTab("dados")}>Dados do produto</button>
            <button type="button" className={modalTab === "historico" ? "active" : ""} onClick={() => setModalTab("historico")}>Histórico</button>
          </div>
        )}
        {item && modalTab === "historico" ? <ProductHistory productId={item.id} close={close} /> : (
        <form className="modal-form" onSubmit={submit}>
          <label>
            TAG
            <div className="combo-with-create">
              <input name="tag" required value={tag} onChange={(event) => setTag(event.target.value.toUpperCase())} disabled={readOnly} />
              {!item && !readOnly && (
                <button type="button" onClick={() => fetchJson<{ tag: string }>("/api/products/next-tag").then((result) => setTag(result.tag)).catch(() => undefined)} title="Usar a próxima TAG disponível">
                  Próxima
                </button>
              )}
            </div>
          </label>
          <label>
            Nome
            <input name="name" required value={name} onChange={(event) => setName(event.target.value)} disabled={readOnly} style={{ textTransform: "uppercase" }} autoComplete="off" />
          </label>
          {showSimilar && (
            <div className="product-similar-warning full" role="status">
              <strong>⚠ Já existe produto com nome muito parecido. É o mesmo item?</strong>
              <ul>
                {similar.map((match) => (
                  <li key={match.id}>
                    <span>
                      <b>{match.name}</b> · TAG {match.tag} · {match.fronts.length ? match.fronts.map((front) => front.name).join(", ") : "inativo em todas as frentes"} <small>({match.score}% parecido)</small>
                    </span>
                    <span className="product-similar-actions">
                      {!item && !match.activeHere && singleFront && canActivate && (
                        <button type="button" disabled={busy} onClick={async () => { if (await toggleFront(singleFront, true, match.id)) await saved(`Produto TAG ${match.tag} ativado em ${singleFront.name} (sem novo cadastro).`); }}>
                          Usar este (ativar em {singleFront.name})
                        </button>
                      )}
                      <button type="button" onClick={() => openExisting(match.id)}>Abrir</button>
                    </span>
                  </li>
                ))}
              </ul>
              <button type="button" className="link-button" onClick={() => setSimilarDismissed(true)}>É um produto diferente — continuar o cadastro</button>
            </div>
          )}
          <div className="full product-references">
            <span>Referências</span>
            <div className="product-reference-chips">
              {references.length === 0 && <small>Nenhuma referência.</small>}
              {references.map((reference) => (
                <span key={reference} className="product-reference-chip">
                  {reference}
                  {!readOnly && <button type="button" aria-label={`Remover ${reference}`} onClick={() => setReferences((current) => current.filter((value) => value !== reference))}>×</button>}
                </span>
              ))}
            </div>
            {!readOnly && (
              <div className="combo-with-create">
                <input placeholder="Adicionar referência (Enter)" value={referenceInput} onChange={(event) => setReferenceInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addReference(); } }} style={{ textTransform: "uppercase" }} />
                <button type="button" onClick={addReference}>＋ Adicionar</button>
              </div>
            )}
            <small>Cada referência só pode existir em um produto do sistema.</small>
          </div>
          <label>
            Preço
            <input name="price" required inputMode="decimal" defaultValue={item ? String(item.price).replace(".", ",") : "0"} disabled={readOnly} />
          </label>
          <label>
            Marca
            <input name="brand" defaultValue={item?.brand ?? ""} disabled={readOnly} />
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
          <div className="full product-applications">
            <span>Aplicação <small>({modelIds.length ? `${modelIds.length} modelo(s)` : "nenhuma = uso geral"})</small></span>
            {!readOnly && <input placeholder="Filtrar modelos..." value={modelFilter} onChange={(event) => setModelFilter(event.target.value)} />}
            <div className="product-application-list">
              {filteredModels.map((model) => (
                <label key={model.id} className={modelIds.includes(model.id) ? "selected" : ""}>
                  <input type="checkbox" checked={modelIds.includes(model.id)} disabled={readOnly} onChange={(event) => setModelIds((current) => (event.target.checked ? [...current, model.id] : current.filter((id) => id !== model.id)))} />
                  {model.name}
                </label>
              ))}
              {filteredModels.length === 0 && <small>Nenhum modelo encontrado.</small>}
            </div>
          </div>
          <div className="full product-photos">
            <span>Fotos</span>
            <div className="product-photo-grid">
              {photoIds.map((photoId) => (
                <figure key={photoId}>
                  <a href={`/api/products/photos/${photoId}`} target="_blank" rel="noopener noreferrer"><img src={`/api/products/photos/${photoId}`} alt="Foto do produto" /></a>
                  {!readOnly && can(authUser, "products.edit") && <button type="button" onClick={() => removePhoto(photoId)} aria-label="Remover foto">×</button>}
                </figure>
              ))}
              {pendingPhotos.map((photo) => (
                <figure key={photo.url} className="pending">
                  <img src={photo.url} alt="Foto a enviar" />
                  <button type="button" onClick={() => { URL.revokeObjectURL(photo.url); setPendingPhotos((current) => current.filter((value) => value.url !== photo.url)); }} aria-label="Descartar foto">×</button>
                </figure>
              ))}
              {canUploadPhotos && (
                <button type="button" className="product-photo-add" onClick={() => fileInput.current?.click()}>＋<small>Adicionar fotos</small></button>
              )}
              {photoIds.length === 0 && pendingPhotos.length === 0 && !canUploadPhotos && <small>Sem fotos.</small>}
            </div>
            <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={pickPhotos} />
          </div>
          {!item && fronts.length > 1 && (
            <label className="full">
              Ativar na frente de serviço
              <select required value={creationFrontId} onChange={(event) => setCreationFrontId(event.target.value)}>
                <option value="">Selecione a frente...</option>
                {fronts.map((front) => <option key={front.id} value={front.id}>{front.name}</option>)}
              </select>
              <small>O produto fica ativo nesta frente com estoque zerado e aparece (apagado) nas demais, que podem ativá-lo sem novo cadastro.</small>
            </label>
          )}
          {!item && fronts.length <= 1 && <p className="full product-stock-note">Estoque inicial zerado{fronts[0] ? ` em ${fronts[0].name}` : ""}. Lance a entrada depois, no estoque da frente.</p>}
          {item && (
            <div className="full product-stock-editor">
              <span>Estoque por frente</span>
              <table>
                <tbody>
                  {fronts.map((front) => {
                    const row = stockRows.find((value) => value.serviceFrontId === front.id);
                    const active = Boolean(row?.active);
                    return (
                      <tr key={front.id} className={active ? "" : "product-inactive-here"}>
                        <th>{front.name}</th>
                        <td>{active ? "Ativo" : "Inativo nesta frente"}</td>
                        <td>
                          {active ? (
                            <input inputMode="decimal" aria-label={`Quantidade em ${front.name}`} disabled={readOnly} value={stockDraft[front.id] ?? quantityFormat(row?.quantity ?? 0)} onChange={(event) => setStockDraft((current) => ({ ...current, [front.id]: event.target.value }))} />
                          ) : "—"}
                        </td>
                        <td>
                          {canActivate && !active && <button type="button" disabled={busy} onClick={() => toggleFront(front, true)}>Ativar</button>}
                          {canActivate && active && (row?.quantity ?? 0) === 0 && stockDraft[front.id] === undefined && <button type="button" className="link-button" disabled={busy} onClick={() => toggleFront(front, false)}>Desativar</button>}
                        </td>
                      </tr>
                    );
                  })}
                  {stockRows.filter((row) => row.active && !fronts.some((front) => front.id === row.serviceFrontId)).map((row) => (
                    <tr key={row.serviceFrontId} className="product-other-front"><th>{row.name}</th><td>Ativo (outra frente)</td><td><span className="product-stock-readonly" title="Somente leitura — estoque de outra frente">{quantityFormat(row.quantity)}</span></td><td /></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
        )}
      </section>
    </div>
  );
}

// Aba Histórico: entradas e saídas deste produto com o número do lançamento de origem.
function ProductHistory({ productId, close }: { productId: number; close: () => void }) {
  const [rows, setRows] = useState<StockMovementRow[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetchJson<{ movements: StockMovementRow[] }>(`/api/products/${productId}/movements`).then((result) => setRows(result.movements)).catch((problem) => setError(problem instanceof Error ? problem.message : "Não foi possível carregar o histórico."));
  }, [productId]);
  const entries = rows?.filter((row) => row.type === "ENTRADA" && !row.reversed).reduce((total, row) => total + row.quantity, 0) ?? 0;
  const exits = rows?.filter((row) => row.type === "SAIDA" && !row.reversed).reduce((total, row) => total + row.quantity, 0) ?? 0;
  return (
    <div className="modal-form product-history-panel">
      <p className="full product-history-summary">Entradas: <strong>{entries.toLocaleString("pt-BR")}</strong> · Saídas: <strong>{exits.toLocaleString("pt-BR")}</strong> · {rows?.length ?? 0} lançamento(s) nas frentes que você enxerga.</p>
      {error && <div className="equipment-form-error full"><span>!</span><strong>{error}</strong></div>}
      <div className="full">{rows === null && !error ? <div className="page-loading"><span /><p>Carregando histórico...</p></div> : <StockMovementsTable rows={rows ?? []} showProduct={false} empty="Nenhuma movimentação registrada para este produto." />}</div>
      <div className="modal-footer full"><button type="button" className="secondary" onClick={close}>Fechar</button></div>
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
