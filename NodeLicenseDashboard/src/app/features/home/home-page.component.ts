import { Component, OnInit, ViewChild } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

import { NimbleTableDirective } from '@ni/nimble-angular/table';

import { AppViewStateService } from '../../core/state/app-view-state.service';
import {
  HomePageModel,
  NodeDetailRow,
  WebappHomeDataService,
} from '../../core/systemlink/webapp-home-data.service';
import { ViewState } from '../../shared/states/view-state.model';

interface StatTile {
  key: string;
  label: string;
  value: number;
  color: string;
}

interface PieSlice {
  path: string;
  color: string;
  percent: string;
  label: string;
  count: number;
  labelX: number;
  labelY: number;
}

interface BarColumn {
  month: string;
  x: number;
  barWidth: number;
  managedY: number;
  managedHeight: number;
  unmanagedY: number;
  unmanagedHeight: number;
  managedLabelY: number;
  unmanagedLabelY: number;
  totalLabelY: number;
  managed: number;
  unmanaged: number;
  total: number;
}

interface AxisTick {
  value: number;
  y: number;
}

const MANAGED_COLOR = '#3aa655';
const UNMANAGED_COLOR = '#5b9bd5';
const INACTIVE_COLOR = '#e0b93a';
const VIRTUAL_COLOR = '#9b6dd6';

const BAR_WIDTH_TOTAL = 760;
const BAR_HEIGHT_TOTAL = 190;
const BAR_PADDING = { top: 20, right: 16, bottom: 28, left: 44 };

@Component({
  selector: 'sl-home-page',
  standalone: false,
  templateUrl: './home-page.component.html',
  styleUrl: './home-page.component.scss',
})
export class HomePageComponent implements OnInit {
  state: ViewState<HomePageModel>;

  readonly managedColor = MANAGED_COLOR;
  readonly unmanagedColor = UNMANAGED_COLOR;
  readonly inactiveColor = INACTIVE_COLOR;
  readonly virtualColor = VIRTUAL_COLOR;
  readonly barWidth = BAR_WIDTH_TOTAL;
  readonly barHeight = BAR_HEIGHT_TOTAL;
  readonly axisLeft = BAR_PADDING.left;
  readonly axisRight = BAR_WIDTH_TOTAL - BAR_PADDING.right;
  readonly axisBottom = BAR_HEIGHT_TOTAL - BAR_PADDING.bottom;

  tiles: StatTile[] = [];
  pieSlices: PieSlice[] = [];
  bars: BarColumn[] = [];
  axisTicks: AxisTick[] = [];
  activeFilter = 'total';

  private allRows: NodeDetailRow[] = [];

  @ViewChild(NimbleTableDirective) private table?: NimbleTableDirective<NodeDetailRow>;

  readonly detailData$ = new BehaviorSubject<NodeDetailRow[]>([]);

  tooltip = { visible: false, x: 0, y: 0, text: '' };

  constructor(
    private readonly dataService: WebappHomeDataService,
    appViewState: AppViewStateService,
  ) {
    this.state = appViewState.create<HomePageModel>();
  }

  ngOnInit(): void {
    void this.reload();
  }

  async reload(): Promise<void> {
    this.state = { ...this.state, isLoading: true, error: null };
    try {
      const value = await this.dataService.load();
      this.state = { value, isLoading: false, error: null };
      this.buildCharts(value);
      this.allRows = [...value.detail].sort((a, b) => b.lastActive.localeCompare(a.lastActive));
      this.applyFilter();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to load node license data.';
      this.state = { ...this.state, isLoading: false, error: message };
    }
  }

  showTip(event: MouseEvent, text: string): void {
    this.tooltip = { visible: true, x: event.clientX + 12, y: event.clientY + 12, text };
  }

  hideTip(): void {
    this.tooltip = { ...this.tooltip, visible: false };
  }

  selectTile(key: string): void {
    // Clicking the active non-total card again clears the filter back to all nodes.
    this.activeFilter = this.activeFilter === key && key !== 'total' ? 'total' : key;
    this.applyFilter();
  }

  async onRowDoubleClick(): Promise<void> {
    if (!this.table) {
      return;
    }
    const [rowId] = await this.table.getSelectedRecordIds();
    const row = this.allRows.find((r) => r.rowId === rowId);
    if (!row?.hostRaw) {
      return;
    }
    const url = await this.dataService.getLatestResultUrl(row.hostRaw);
    if (url) {
      window.open(url, '_blank');
    }
  }

  private applyFilter(): void {
    const predicate = (row: NodeDetailRow): boolean => {
      switch (this.activeFilter) {
        case 'managed':
          return row.nodeType === 'Managed';
        case 'unmanaged':
          return row.nodeType === 'Unmanaged';
        case 'inactive':
          return row.status === 'Inactive';
        case 'virtual':
          return row.status === 'Virtual';
        default:
          return true;
      }
    };
    this.detailData$.next(this.allRows.filter(predicate));
  }

  private buildCharts(model: HomePageModel): void {
    this.tiles = [
      { key: 'total', label: 'Total Nodes', value: model.managed + model.unmanaged, color: 'var(--app-strong)' },
      { key: 'managed', label: 'Managed', value: model.managed, color: MANAGED_COLOR },
      { key: 'unmanaged', label: 'Unmanaged', value: model.unmanaged, color: UNMANAGED_COLOR },
      { key: 'inactive', label: 'Managed (Inactive)', value: model.inactive, color: INACTIVE_COLOR },
      { key: 'virtual', label: 'Unmanaged (Virtual)', value: model.virtual, color: VIRTUAL_COLOR },
    ];
    this.pieSlices = this.buildPie(model.managed, model.unmanaged);
    this.buildBars(model);
  }

  private buildPie(managed: number, unmanaged: number): PieSlice[] {
    const total = managed + unmanaged;
    if (total === 0) {
      return [];
    }

    const cx = 110;
    const cy = 110;
    const r = 100;
    const segments = [
      { value: managed, color: MANAGED_COLOR, label: 'Managed' },
      { value: unmanaged, color: UNMANAGED_COLOR, label: 'Unmanaged' },
    ];

    const slices: PieSlice[] = [];
    let startAngle = -Math.PI / 2;
    for (const segment of segments) {
      if (segment.value === 0) {
        continue;
      }
      const fraction = segment.value / total;
      const endAngle = startAngle + fraction * 2 * Math.PI;
      const midAngle = (startAngle + endAngle) / 2;
      const largeArc = fraction > 0.5 ? 1 : 0;
      const x1 = cx + r * Math.cos(startAngle);
      const y1 = cy + r * Math.sin(startAngle);
      const x2 = cx + r * Math.cos(endAngle);
      const y2 = cy + r * Math.sin(endAngle);
      slices.push({
        path: `M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`,
        color: segment.color,
        percent: `${Math.round(fraction * 100)}%`,
        label: segment.label,
        count: segment.value,
        labelX: cx + r * 0.55 * Math.cos(midAngle),
        labelY: cy + r * 0.55 * Math.sin(midAngle),
      });
      startAngle = endAngle;
    }
    return slices;
  }

  private buildBars(model: HomePageModel): void {
    const trend = model.trend;
    const plotHeight = this.axisBottom - BAR_PADDING.top;
    const innerWidth = this.axisRight - this.axisLeft;
    const maxTotal = this.niceMax(Math.max(1, ...trend.map((p) => p.managed + p.unmanaged)));

    const slot = trend.length > 0 ? innerWidth / trend.length : innerWidth;
    const barWidth = slot * 0.6;

    this.bars = trend.map((point, index) => {
      const total = point.managed + point.unmanaged;
      const x = this.axisLeft + slot * index + (slot - barWidth) / 2;
      const unmanagedHeight = (point.unmanaged / maxTotal) * plotHeight;
      const managedHeight = (point.managed / maxTotal) * plotHeight;
      const unmanagedY = this.axisBottom - unmanagedHeight;
      const managedY = unmanagedY - managedHeight;
      return {
        month: point.month,
        x,
        barWidth,
        unmanagedY,
        unmanagedHeight,
        managedY,
        managedHeight,
        managedLabelY: managedY + managedHeight / 2 + 4,
        unmanagedLabelY: unmanagedY + unmanagedHeight / 2 + 4,
        totalLabelY: managedY - 6,
        managed: point.managed,
        unmanaged: point.unmanaged,
        total,
      };
    });

    const tickCount = 5;
    this.axisTicks = Array.from({ length: tickCount + 1 }, (_, i) => {
      const value = Math.round((maxTotal / tickCount) * i);
      return { value, y: this.axisBottom - (value / maxTotal) * plotHeight };
    });
  }

  private niceMax(value: number): number {
    const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
    const normalized = value / magnitude;
    let nice: number;
    if (normalized <= 1) {
      nice = 1;
    } else if (normalized <= 2) {
      nice = 2;
    } else if (normalized <= 5) {
      nice = 5;
    } else {
      nice = 10;
    }
    return nice * magnitude;
  }
}
