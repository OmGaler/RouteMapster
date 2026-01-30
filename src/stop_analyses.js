(() => {
  const initStopAnalyses = (container, appState) => {
    if (!container) {
      return;
    }
    const target = container.querySelector ? (container.querySelector("#stopAnalysesContainer") || container) : container;
    target.innerHTML = `
      <div class="module-note">Stop dataset + computations will be added next.</div>
      <div class="module-section">
        <div class="section-title">Inputs</div>
        <div class="field">
          <label>Stop scope</label>
          <select class="select-field" disabled>
            <option>All stops (coming soon)</option>
          </select>
        </div>
        <div class="field">
          <label>Filters</label>
          <div class="info-empty">Stop filters will appear here once datasets are wired.</div>
        </div>
      </div>
      <div class="module-section">
        <div class="section-title">Presets</div>
        <div class="preset-grid">
          <button type="button" class="preset-card is-disabled" disabled>
            <div class="preset-card__icon">[ ]</div>
            <div class="preset-card__title">Connectivity hotspots</div>
            <div class="preset-card__desc">Top connected stops and corridors.</div>
          </button>
          <button type="button" class="preset-card is-disabled" disabled>
            <div class="preset-card__icon">[ ]</div>
            <div class="preset-card__title">Coverage gaps</div>
            <div class="preset-card__desc">Neighbourhoods with sparse stop coverage.</div>
          </button>
        </div>
      </div>
      <div class="module-section">
        <div class="section-title">Outputs</div>
        <div class="analysis-block module-disabled">
          <div class="analysis-block__header">
            <div class="analysis-block__title">Coming next</div>
          </div>
          <ul class="coming-next">
            <li>Stop centrality (degree / betweenness)</li>
            <li>Most connected stops</li>
            <li>Underserved postcode districts by stop coverage</li>
            <li>Stop density heatmap</li>
          </ul>
        </div>
        <div class="info-empty">Charts and tables will render here in the next release.</div>
      </div>
    `;
  };

  window.RouteMapsterStopAnalyses = {
    initStopAnalyses
  };
})();

