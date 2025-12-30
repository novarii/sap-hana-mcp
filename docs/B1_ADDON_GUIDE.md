# SAP Business One Addon Development Guide

## İş Emri Sorgulama Addon - Implementation Guide

This guide covers building the Production Order Query addon using .NET Framework 4.8, C#, and SAP B1 SDK.

---

## Table of Contents

1. [SDK Overview](#sdk-overview)
2. [Project Setup](#project-setup)
3. [Connecting to SAP B1](#connecting-to-sap-b1)
4. [UI API - Forms & Events](#ui-api---forms--events)
5. [DI API - Data Operations](#di-api---data-operations)
6. [Implementation Architecture](#implementation-architecture)
7. [Core Features Implementation](#core-features-implementation)
8. [Deployment](#deployment)

---

## SDK Overview

SAP B1 SDK consists of two main components:

| API | Library | Purpose |
|-----|---------|---------|
| **UI API** | `SAPbouiCOM.dll` | User interface, forms, menus, events |
| **DI API** | `SAPbobsCOM.dll` | Data manipulation, business objects, transactions |

### When to Use Each

```
UI API (SAPbouiCOM)          DI API (SAPbobsCOM)
├── Create custom forms      ├── Create/Update documents
├── Add menu items           ├── Query data (Recordset)
├── Handle user events       ├── Business object operations
├── Display messages         ├── User-defined tables/fields
└── Grid/Matrix controls     └── Transactions
```

---

## Project Setup

### 1. Create Visual Studio Project

```
File → New → Project → Windows Forms App (.NET Framework)
Framework: .NET Framework 4.8
Platform: x64 (required for SAP B1 10.0+)
```

### 2. Add COM References

Right-click References → Add Reference → COM:

- `SAP Business One DI API` (SAPbobsCOM)
- `SAP Business One UI API` (SAPbouiCOM)

Or browse to:
```
C:\Program Files\SAP\SAP Business One DI API\
C:\Program Files\SAP\SAP Business One\
```

### 3. Project Structure

```
IsEmriSorgulama/
├── IsEmriSorgulama.sln
├── IsEmriSorgulama/
│   ├── Program.cs                 # Entry point
│   ├── App.config                 # Configuration
│   ├── Core/
│   │   ├── B1Connection.cs        # SAP connection singleton
│   │   ├── B1Application.cs       # UI API wrapper
│   │   └── EventHandlers.cs       # Global event handlers
│   ├── Forms/
│   │   ├── IsEmriSorgulamaForm.cs # Main query form
│   │   ├── IsEmriSorgulamaForm.srf # Form XML definition
│   │   └── FilterPanel.cs         # Filter controls
│   ├── Services/
│   │   ├── ProductionOrderService.cs  # OWOR operations
│   │   ├── BOMService.cs              # BOM explosion
│   │   └── MESService.cs              # @ATELIERATTN operations
│   ├── Models/
│   │   ├── ProductionOrder.cs
│   │   ├── BOMNode.cs
│   │   └── FilterCriteria.cs
│   └── Queries/
│       └── ProductionQueries.cs   # SQL queries
├── Resources/
│   └── Forms/                     # .srf form files
└── packages.config
```

### 4. App.config

```xml
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <appSettings>
    <!-- Connection settings for standalone DI API testing -->
    <add key="Server" value="192.168.0.150"/>
    <add key="CompanyDB" value="DENEME_URETIM_TEST"/>
    <add key="DbServerType" value="dst_HANADB"/>
    <add key="UserName" value="manager"/>
    <add key="Password" value=""/>
    <add key="LicenseServer" value="192.168.0.150:30000"/>
  </appSettings>
  <startup>
    <supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8"/>
  </startup>
</configuration>
```

---

## Connecting to SAP B1

### UI API Connection (Addon Mode)

When running as an addon, connect via the running SAP B1 client:

```csharp
// Program.cs
using SAPbouiCOM;
using System;
using System.Windows.Forms;

namespace IsEmriSorgulama
{
    static class Program
    {
        public static SAPbouiCOM.Application SBO_Application;

        [STAThread]
        static void Main(string[] args)
        {
            try
            {
                // Get connection string from command line (passed by SAP B1)
                string connectionString = args.Length > 0 ? args[0] : "";

                if (string.IsNullOrEmpty(connectionString))
                {
                    // Development mode - connect to running SAP B1 instance
                    connectionString = GetDevelopmentConnectionString();
                }

                // Connect to SAP B1 UI
                ConnectToUI(connectionString);

                // Initialize addon
                var addon = new AddonMain();
                addon.Initialize();

                // Keep application running
                Application.Run();
            }
            catch (Exception ex)
            {
                MessageBox.Show($"Addon başlatılamadı: {ex.Message}", "Hata",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private static void ConnectToUI(string connectionString)
        {
            SAPbouiCOM.SboGuiApi sboGuiApi = new SAPbouiCOM.SboGuiApi();
            sboGuiApi.Connect(connectionString);
            SBO_Application = sboGuiApi.GetApplication(-1);

            // Set application events
            SBO_Application.AppEvent += new _IApplicationEvents_AppEventEventHandler(OnAppEvent);
        }

        private static string GetDevelopmentConnectionString()
        {
            // For development/debugging - connects to running SAP B1
            return "0030002C0030002C00530041005000420044005F00440061007400650076002C0050004C006F006D0056004900490056";
        }

        private static void OnAppEvent(BoAppEventTypes EventType)
        {
            if (EventType == BoAppEventTypes.aet_ShutDown ||
                EventType == BoAppEventTypes.aet_CompanyChanged)
            {
                Application.Exit();
            }
        }
    }
}
```

### DI API Connection (via UI API)

Get DI Company object from UI connection:

```csharp
// Core/B1Connection.cs
using SAPbobsCOM;
using SAPbouiCOM;

namespace IsEmriSorgulama.Core
{
    public class B1Connection
    {
        private static B1Connection _instance;
        private static readonly object _lock = new object();

        public SAPbouiCOM.Application Application { get; private set; }
        public SAPbobsCOM.Company Company { get; private set; }

        public static B1Connection Instance
        {
            get
            {
                if (_instance == null)
                {
                    lock (_lock)
                    {
                        if (_instance == null)
                            _instance = new B1Connection();
                    }
                }
                return _instance;
            }
        }

        public void Initialize(SAPbouiCOM.Application app)
        {
            Application = app;

            // Get DI Company from UI Application (single sign-on)
            Company = (SAPbobsCOM.Company)app.Company.GetDICompany();
        }

        /// <summary>
        /// Execute a SQL query and return recordset
        /// </summary>
        public Recordset ExecuteQuery(string sql)
        {
            Recordset rs = (Recordset)Company.GetBusinessObject(BoObjectTypes.BoRecordset);
            rs.DoQuery(sql);
            return rs;
        }

        /// <summary>
        /// Execute query and return DataTable for grid binding
        /// </summary>
        public System.Data.DataTable ExecuteQueryToDataTable(string sql)
        {
            var dt = new System.Data.DataTable();
            Recordset rs = ExecuteQuery(sql);

            // Add columns
            for (int i = 0; i < rs.Fields.Count; i++)
            {
                dt.Columns.Add(rs.Fields.Item(i).Name);
            }

            // Add rows
            while (!rs.EoF)
            {
                var row = dt.NewRow();
                for (int i = 0; i < rs.Fields.Count; i++)
                {
                    row[i] = rs.Fields.Item(i).Value;
                }
                dt.Rows.Add(row);
                rs.MoveNext();
            }

            System.Runtime.InteropServices.Marshal.ReleaseComObject(rs);
            return dt;
        }
    }
}
```

---

## UI API - Forms & Events

### Creating the Main Form

```csharp
// Forms/IsEmriSorgulamaForm.cs
using SAPbouiCOM;
using System;

namespace IsEmriSorgulama.Forms
{
    public class IsEmriSorgulamaForm
    {
        private const string FORM_TYPE = "ISEMRI_SORGULAMA";
        private Form _form;
        private Grid _grid;
        private B1Connection _conn;

        public IsEmriSorgulamaForm()
        {
            _conn = B1Connection.Instance;
        }

        public void Show()
        {
            try
            {
                // Check if form already exists
                _form = _conn.Application.Forms.Item(FORM_TYPE);
                _form.Select();
            }
            catch
            {
                // Create new form
                CreateForm();
            }
        }

        private void CreateForm()
        {
            FormCreationParams creationParams =
                (FormCreationParams)_conn.Application.CreateObject(BoCreatableObjectType.cot_FormCreationParams);

            creationParams.UniqueID = FORM_TYPE;
            creationParams.FormType = FORM_TYPE;
            creationParams.BorderStyle = BoFormBorderStyle.fbs_Sizable;

            _form = _conn.Application.Forms.AddEx(creationParams);
            _form.Title = "İş Emri Sorgulama";
            _form.Left = 100;
            _form.Top = 100;
            _form.Width = 1200;
            _form.Height = 700;

            // Add controls
            AddFilterControls();
            AddGrid();
            AddButtons();

            _form.Visible = true;
        }

        private void AddFilterControls()
        {
            int top = 10;
            int labelWidth = 120;
            int fieldWidth = 150;
            int col1 = 10;
            int col2 = 300;
            int col3 = 590;

            // Row 1: Date filters
            AddLabel("lblStartDate", col1, top, "Başlangıç Tarihi:");
            AddDatePicker("dpStartDate", col1 + labelWidth, top);

            AddLabel("lblEndDate", col2, top, "Bitiş Tarihi:");
            AddDatePicker("dpEndDate", col2 + labelWidth, top);

            // Row 2: Work Order / Customer
            top += 25;
            AddLabel("lblWorkOrder", col1, top, "İş Emri No:");
            AddEditText("txtWorkOrder", col1 + labelWidth, top, fieldWidth);

            AddLabel("lblCustomer", col2, top, "Müşteri Kodu:");
            AddEditText("txtCustomer", col2 + labelWidth, top, fieldWidth);
            AddLinkedButton("btnCustomer", col2 + labelWidth + fieldWidth + 5, top, "txtCustomer", "2"); // CardCode CFL

            // Row 3: Item Code / Status
            top += 25;
            AddLabel("lblItemCode", col1, top, "Kalem Kodu:");
            AddEditText("txtItemCode", col1 + labelWidth, top, fieldWidth);
            AddLinkedButton("btnItemCode", col1 + labelWidth + fieldWidth + 5, top, "txtItemCode", "4"); // ItemCode CFL

            AddLabel("lblStatus", col2, top, "Durum:");
            AddComboBox("cmbStatus", col2 + labelWidth, top, fieldWidth);

            // Status dropdown values
            var combo = (ComboBox)_form.Items.Item("cmbStatus").Specific;
            combo.ValidValues.Add("", "Tümü");
            combo.ValidValues.Add("P", "Planlanan");
            combo.ValidValues.Add("R", "Onaylanan");
            combo.ValidValues.Add("C", "Tamamlanan");
            combo.ValidValues.Add("L", "İptal");
            combo.Select(0, BoSearchKey.psk_Index);
        }

        private void AddGrid()
        {
            Item gridItem = _form.Items.Add("grid", BoFormItemTypes.it_GRID);
            gridItem.Left = 10;
            gridItem.Top = 120;
            gridItem.Width = _form.Width - 30;
            gridItem.Height = _form.Height - 200;
            gridItem.AffectsFormMode = false;

            _grid = (Grid)gridItem.Specific;
            _grid.SelectionMode = BoMatrixSelect.ms_Single;
        }

        private void AddButtons()
        {
            int buttonTop = _form.Height - 60;
            int buttonWidth = 100;

            AddButton("btnSearch", 10, buttonTop, "Ara");
            AddButton("btnApprove", 120, buttonTop, "Seçilenleri Onayla");
            AddButton("btnUpdateDates", 230, buttonTop, "Tarihleri Güncelle");
            AddButton("btnRefresh", 340, buttonTop, "Yenile");
        }

        #region Helper Methods

        private void AddLabel(string uid, int left, int top, string caption)
        {
            Item item = _form.Items.Add(uid, BoFormItemTypes.it_STATIC);
            item.Left = left;
            item.Top = top;
            item.Width = 115;
            item.Height = 14;
            ((StaticText)item.Specific).Caption = caption;
        }

        private void AddEditText(string uid, int left, int top, int width)
        {
            Item item = _form.Items.Add(uid, BoFormItemTypes.it_EDIT);
            item.Left = left;
            item.Top = top;
            item.Width = width;
            item.Height = 14;
        }

        private void AddDatePicker(string uid, int left, int top)
        {
            Item item = _form.Items.Add(uid, BoFormItemTypes.it_EDIT);
            item.Left = left;
            item.Top = top;
            item.Width = 100;
            item.Height = 14;

            EditText edit = (EditText)item.Specific;
            edit.DataBind.SetBound(true, "", uid);
            _form.DataSources.UserDataSources.Add(uid, BoDataType.dt_DATE);
        }

        private void AddComboBox(string uid, int left, int top, int width)
        {
            Item item = _form.Items.Add(uid, BoFormItemTypes.it_COMBO_BOX);
            item.Left = left;
            item.Top = top;
            item.Width = width;
            item.Height = 14;
        }

        private void AddButton(string uid, int left, int top, string caption)
        {
            Item item = _form.Items.Add(uid, BoFormItemTypes.it_BUTTON);
            item.Left = left;
            item.Top = top;
            item.Width = 100;
            item.Height = 19;
            ((Button)item.Specific).Caption = caption;
        }

        private void AddLinkedButton(string uid, int left, int top, string linkedEdit, string objectType)
        {
            Item item = _form.Items.Add(uid, BoFormItemTypes.it_LINKED_BUTTON);
            item.Left = left;
            item.Top = top;
            item.Width = 15;
            item.Height = 14;
            item.LinkTo = linkedEdit;

            LinkedButton lb = (LinkedButton)item.Specific;
            lb.LinkedObject = (BoLinkedObject)int.Parse(objectType);
        }

        #endregion
    }
}
```

### Event Handling

```csharp
// Core/EventHandlers.cs
using SAPbouiCOM;
using System;

namespace IsEmriSorgulama.Core
{
    public class EventHandlers
    {
        private SAPbouiCOM.Application _app;
        private IsEmriSorgulamaForm _mainForm;

        public EventHandlers(SAPbouiCOM.Application app)
        {
            _app = app;
            RegisterEvents();
        }

        private void RegisterEvents()
        {
            // Set event filters
            EventFilters filters = new EventFilters();
            EventFilter filter = filters.Add(BoEventTypes.et_ITEM_PRESSED);
            filter.AddEx("ISEMRI_SORGULAMA");

            filter = filters.Add(BoEventTypes.et_COMBO_SELECT);
            filter.AddEx("ISEMRI_SORGULAMA");

            filter = filters.Add(BoEventTypes.et_CHOOSE_FROM_LIST);
            filter.AddEx("ISEMRI_SORGULAMA");

            filter = filters.Add(BoEventTypes.et_MENU_CLICK);

            _app.SetFilter(filters);

            // Register handlers
            _app.ItemEvent += OnItemEvent;
            _app.MenuEvent += OnMenuEvent;
        }

        private void OnItemEvent(string FormUID, ref ItemEvent pVal, out bool BubbleEvent)
        {
            BubbleEvent = true;

            if (pVal.FormTypeEx != "ISEMRI_SORGULAMA")
                return;

            if (pVal.EventType == BoEventTypes.et_ITEM_PRESSED && !pVal.BeforeAction)
            {
                switch (pVal.ItemUID)
                {
                    case "btnSearch":
                        OnSearchClicked();
                        break;
                    case "btnApprove":
                        OnApproveClicked();
                        break;
                    case "btnUpdateDates":
                        OnUpdateDatesClicked();
                        break;
                    case "btnRefresh":
                        OnRefreshClicked();
                        break;
                }
            }
        }

        private void OnMenuEvent(ref MenuEvent pVal, out bool BubbleEvent)
        {
            BubbleEvent = true;

            if (pVal.MenuUID == "MNU_ISEMRI_SORGULAMA" && !pVal.BeforeAction)
            {
                _mainForm = new IsEmriSorgulamaForm();
                _mainForm.Show();
            }
        }

        private void OnSearchClicked()
        {
            // Get filter values and query
            var service = new ProductionOrderService();
            var criteria = GetFilterCriteria();
            var orders = service.GetProductionOrders(criteria);
            // Bind to grid...
        }

        private void OnApproveClicked()
        {
            // Change status P → R for selected orders
            var service = new ProductionOrderService();
            var selectedOrders = GetSelectedOrders();

            foreach (var docEntry in selectedOrders)
            {
                service.ApproveOrder(docEntry);
            }

            _app.MessageBox("Seçilen iş emirleri onaylandı.");
            OnRefreshClicked();
        }

        private void OnUpdateDatesClicked()
        {
            // Show date update dialog
        }

        private void OnRefreshClicked()
        {
            OnSearchClicked();
        }

        private FilterCriteria GetFilterCriteria()
        {
            // Read values from form controls
            return new FilterCriteria();
        }

        private int[] GetSelectedOrders()
        {
            // Get selected rows from grid
            return new int[0];
        }
    }
}
```

### Adding Menu Item

```csharp
// AddonMain.cs
using SAPbouiCOM;

namespace IsEmriSorgulama
{
    public class AddonMain
    {
        private SAPbouiCOM.Application _app;
        private EventHandlers _eventHandlers;

        public void Initialize()
        {
            _app = Program.SBO_Application;
            B1Connection.Instance.Initialize(_app);

            AddMenuItems();

            _eventHandlers = new EventHandlers(_app);

            _app.StatusBar.SetText("İş Emri Sorgulama Addon yüklendi.",
                BoMessageTime.bmt_Short, BoStatusBarMessageType.smt_Success);
        }

        private void AddMenuItems()
        {
            Menus menus = _app.Menus;

            // Add under Production module (menu UID: 3072)
            MenuCreationParams menuParams =
                (MenuCreationParams)_app.CreateObject(BoCreatableObjectType.cot_MenuCreationParams);

            menuParams.UniqueID = "MNU_ISEMRI_SORGULAMA";
            menuParams.Type = BoMenuType.mt_STRING;
            menuParams.String = "İş Emri Sorgulama";
            menuParams.Position = -1; // At end

            try
            {
                menus.Item("3072").SubMenus.AddEx(menuParams); // Production menu
            }
            catch
            {
                // Menu already exists
            }
        }
    }
}
```

---

## DI API - Data Operations

### Production Order Service

```csharp
// Services/ProductionOrderService.cs
using SAPbobsCOM;
using System;
using System.Collections.Generic;

namespace IsEmriSorgulama.Services
{
    public class ProductionOrderService
    {
        private B1Connection _conn;

        public ProductionOrderService()
        {
            _conn = B1Connection.Instance;
        }

        /// <summary>
        /// Get production orders with filters
        /// </summary>
        public List<ProductionOrder> GetProductionOrders(FilterCriteria criteria)
        {
            string sql = BuildQuery(criteria);
            var dt = _conn.ExecuteQueryToDataTable(sql);

            var orders = new List<ProductionOrder>();
            foreach (System.Data.DataRow row in dt.Rows)
            {
                orders.Add(new ProductionOrder
                {
                    DocEntry = Convert.ToInt32(row["DocEntry"]),
                    DocNum = Convert.ToInt32(row["IsEmriNo"]),
                    ItemCode = row["ItemCode"].ToString(),
                    ItemName = row["UrunAdi"].ToString(),
                    CustomerName = row["MusteriAdi"].ToString(),
                    PlannedQty = Convert.ToDecimal(row["PlanlananMiktar"]),
                    RemainingQty = Convert.ToDecimal(row["KalanMiktar"]),
                    Status = row["Status"].ToString(),
                    StartDate = row["PlanlananBaslangic"] as DateTime?,
                    DueDate = row["PlanlananBitis"] as DateTime?,
                    MachineName = row["IslemTipi"]?.ToString()
                });
            }

            return orders;
        }

        private string BuildQuery(FilterCriteria c)
        {
            string sql = @"
                SELECT
                    o.""DocEntry"",
                    o.""DocNum"" as ""IsEmriNo"",
                    o.""ItemCode"",
                    o.""ProdName"" as ""UrunAdi"",
                    o.""PlannedQty"" as ""PlanlananMiktar"",
                    o.""PlannedQty"" - o.""CmpltQty"" as ""KalanMiktar"",
                    o.""Status"",
                    o.""StartDate"" as ""PlanlananBaslangic"",
                    o.""DueDate"" as ""PlanlananBitis"",
                    c.""CardName"" as ""MusteriAdi"",
                    o.""OriginNum"" as ""SiparisNo"",
                    r.""ResName"" as ""IslemTipi"",
                    o.""U_PartiNo"",
                    o.""U_Branch""
                FROM ""OWOR"" o
                LEFT JOIN ""OCRD"" c ON o.""CardCode"" = c.""CardCode""
                LEFT JOIN ""ITT1"" b ON o.""ItemCode"" = b.""Father"" AND b.""Type"" = 290
                LEFT JOIN ""ORSC"" r ON b.""Code"" = r.""ResCode""
                WHERE 1=1";

            if (!string.IsNullOrEmpty(c.Status))
                sql += $" AND o.\"Status\" = '{c.Status}'";

            if (c.StartDate.HasValue)
                sql += $" AND o.\"StartDate\" >= '{c.StartDate:yyyy-MM-dd}'";

            if (c.EndDate.HasValue)
                sql += $" AND o.\"DueDate\" <= '{c.EndDate:yyyy-MM-dd}'";

            if (!string.IsNullOrEmpty(c.CustomerCode))
                sql += $" AND o.\"CardCode\" = '{c.CustomerCode}'";

            if (!string.IsNullOrEmpty(c.ItemCode))
                sql += $" AND o.\"ItemCode\" LIKE '%{c.ItemCode}%'";

            if (c.DocNum.HasValue)
                sql += $" AND o.\"DocNum\" = {c.DocNum}";

            sql += " ORDER BY o.\"DueDate\" ASC";

            return sql;
        }

        /// <summary>
        /// Approve order (change status P → R)
        /// </summary>
        public bool ApproveOrder(int docEntry)
        {
            try
            {
                ProductionOrders order = (ProductionOrders)_conn.Company.GetBusinessObject(
                    BoObjectTypes.oProductionOrders);

                if (order.GetByKey(docEntry))
                {
                    // Change to Released status
                    order.ProductionOrderStatus = BoProductionOrderStatusEnum.boposReleased;

                    int result = order.Update();
                    if (result != 0)
                    {
                        string error = _conn.Company.GetLastErrorDescription();
                        throw new Exception($"İş emri onaylanamadı: {error}");
                    }
                    return true;
                }
                return false;
            }
            catch (Exception ex)
            {
                _conn.Application.MessageBox($"Hata: {ex.Message}");
                return false;
            }
        }

        /// <summary>
        /// Update production order dates
        /// </summary>
        public bool UpdateDates(int docEntry, DateTime? startDate, DateTime? dueDate)
        {
            try
            {
                ProductionOrders order = (ProductionOrders)_conn.Company.GetBusinessObject(
                    BoObjectTypes.oProductionOrders);

                if (order.GetByKey(docEntry))
                {
                    if (startDate.HasValue)
                        order.StartDate = startDate.Value;

                    if (dueDate.HasValue)
                        order.DueDate = dueDate.Value;

                    int result = order.Update();
                    if (result != 0)
                    {
                        string error = _conn.Company.GetLastErrorDescription();
                        throw new Exception($"Tarihler güncellenemedi: {error}");
                    }
                    return true;
                }
                return false;
            }
            catch (Exception ex)
            {
                _conn.Application.MessageBox($"Hata: {ex.Message}");
                return false;
            }
        }
    }
}
```

### BOM Explosion Service

```csharp
// Services/BOMService.cs
using System;
using System.Collections.Generic;
using System.Data;

namespace IsEmriSorgulama.Services
{
    public class BOMService
    {
        private B1Connection _conn;

        public BOMService()
        {
            _conn = B1Connection.Instance;
        }

        /// <summary>
        /// Get full BOM tree for an item (up to 5 levels)
        /// </summary>
        public List<BOMNode> GetBOMTree(string itemCode)
        {
            string sql = BuildBOMExplosionQuery(itemCode);
            var dt = _conn.ExecuteQueryToDataTable(sql);

            var nodes = new List<BOMNode>();
            foreach (DataRow row in dt.Rows)
            {
                nodes.Add(new BOMNode
                {
                    Level = Convert.ToInt32(row["Level"]),
                    ParentCode = row["Father"].ToString(),
                    ItemCode = row["Code"].ToString(),
                    ItemName = row["ItemName"]?.ToString(),
                    Quantity = Convert.ToDecimal(row["Quantity"]),
                    Type = Convert.ToInt32(row["Type"]),
                    TypeName = Convert.ToInt32(row["Type"]) == 4 ? "Kalem" : "Kaynak"
                });
            }

            return nodes;
        }

        /// <summary>
        /// Get machine assignment for an item from BOM
        /// </summary>
        public string GetMachineCode(string itemCode)
        {
            string sql = $@"
                SELECT b.""Code"", r.""ResName""
                FROM ""ITT1"" b
                JOIN ""ORSC"" r ON b.""Code"" = r.""ResCode""
                WHERE b.""Father"" = '{itemCode}' AND b.""Type"" = 290";

            var rs = _conn.ExecuteQuery(sql);
            if (!rs.EoF)
            {
                return rs.Fields.Item("Code").Value.ToString();
            }
            return null;
        }

        /// <summary>
        /// Check if item has a BOM
        /// </summary>
        public bool HasBOM(string itemCode)
        {
            string sql = $@"SELECT COUNT(*) as cnt FROM ""OITT"" WHERE ""Code"" = '{itemCode}'";
            var rs = _conn.ExecuteQuery(sql);
            return Convert.ToInt32(rs.Fields.Item("cnt").Value) > 0;
        }

        private string BuildBOMExplosionQuery(string itemCode)
        {
            // 5-level BOM explosion query
            return $@"
                -- Level 1
                SELECT 1 as ""Level"", '{itemCode}' as ""Root"", l1.""Father"", l1.""Code"",
                       l1.""ItemName"", l1.""Quantity"", l1.""Type""
                FROM ""ITT1"" l1 WHERE l1.""Father"" = '{itemCode}'

                UNION ALL

                -- Level 2
                SELECT 2, '{itemCode}', l2.""Father"", l2.""Code"", l2.""ItemName"",
                       l1.""Quantity"" * l2.""Quantity"", l2.""Type""
                FROM ""ITT1"" l1
                JOIN ""ITT1"" l2 ON l1.""Code"" = l2.""Father""
                WHERE l1.""Father"" = '{itemCode}' AND l1.""Type"" = 4

                UNION ALL

                -- Level 3
                SELECT 3, '{itemCode}', l3.""Father"", l3.""Code"", l3.""ItemName"",
                       l1.""Quantity"" * l2.""Quantity"" * l3.""Quantity"", l3.""Type""
                FROM ""ITT1"" l1
                JOIN ""ITT1"" l2 ON l1.""Code"" = l2.""Father""
                JOIN ""ITT1"" l3 ON l2.""Code"" = l3.""Father""
                WHERE l1.""Father"" = '{itemCode}' AND l1.""Type"" = 4 AND l2.""Type"" = 4

                UNION ALL

                -- Level 4
                SELECT 4, '{itemCode}', l4.""Father"", l4.""Code"", l4.""ItemName"",
                       l1.""Quantity"" * l2.""Quantity"" * l3.""Quantity"" * l4.""Quantity"", l4.""Type""
                FROM ""ITT1"" l1
                JOIN ""ITT1"" l2 ON l1.""Code"" = l2.""Father""
                JOIN ""ITT1"" l3 ON l2.""Code"" = l3.""Father""
                JOIN ""ITT1"" l4 ON l3.""Code"" = l4.""Father""
                WHERE l1.""Father"" = '{itemCode}' AND l1.""Type"" = 4 AND l2.""Type"" = 4 AND l3.""Type"" = 4

                UNION ALL

                -- Level 5
                SELECT 5, '{itemCode}', l5.""Father"", l5.""Code"", l5.""ItemName"",
                       l1.""Quantity"" * l2.""Quantity"" * l3.""Quantity"" * l4.""Quantity"" * l5.""Quantity"", l5.""Type""
                FROM ""ITT1"" l1
                JOIN ""ITT1"" l2 ON l1.""Code"" = l2.""Father""
                JOIN ""ITT1"" l3 ON l2.""Code"" = l3.""Father""
                JOIN ""ITT1"" l4 ON l3.""Code"" = l4.""Father""
                JOIN ""ITT1"" l5 ON l4.""Code"" = l5.""Father""
                WHERE l1.""Father"" = '{itemCode}' AND l1.""Type"" = 4 AND l2.""Type"" = 4
                      AND l3.""Type"" = 4 AND l4.""Type"" = 4

                ORDER BY ""Level"", ""Father""";
        }
    }
}
```

### MES Integration Service

```csharp
// Services/MESService.cs
using SAPbobsCOM;
using System;

namespace IsEmriSorgulama.Services
{
    public class MESService
    {
        private B1Connection _conn;

        public MESService()
        {
            _conn = B1Connection.Instance;
        }

        /// <summary>
        /// Create entry in @ATELIERATTN when worker starts a job
        /// </summary>
        public bool LogWorkStart(int workOrderDocEntry, string resourceCode,
            string employeeId, string processType = "BAS")
        {
            try
            {
                // Get UDT object
                GeneralService gs = _conn.Company.GetCompanyService().GetGeneralService("ATELIERATTN");
                GeneralData data = (GeneralData)gs.GetDataInterface(GeneralServiceDataInterfaces.gsGeneralData);

                // Generate unique code
                data.SetProperty("Code", Guid.NewGuid().ToString());
                data.SetProperty("U_WorkOrder", workOrderDocEntry.ToString());
                data.SetProperty("U_ResCode", resourceCode);
                data.SetProperty("U_EmpId", employeeId);
                data.SetProperty("U_ProcType", processType); // BAS = Start
                data.SetProperty("U_Start", DateTime.Now);

                gs.Add(data);
                return true;
            }
            catch (Exception ex)
            {
                _conn.Application.MessageBox($"MES kaydı oluşturulamadı: {ex.Message}");
                return false;
            }
        }

        /// <summary>
        /// Get active work entries for a work order
        /// </summary>
        public DataTable GetWorkEntries(int workOrderDocEntry)
        {
            string sql = $@"
                SELECT ""Code"", ""U_ResCode"", ""U_EmpId"", ""U_ProcType"",
                       ""U_Start"", ""CreateDate""
                FROM ""@ATELIERATTN""
                WHERE ""U_WorkOrder"" = '{workOrderDocEntry}'
                ORDER BY ""CreateDate"" DESC";

            return _conn.ExecuteQueryToDataTable(sql);
        }
    }
}
```

---

## Implementation Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Presentation Layer                        │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  IsEmriSorgulamaForm.cs                                  │   │
│  │  - Filter Panel (dates, customer, status, etc.)          │   │
│  │  - Grid (production orders list)                         │   │
│  │  - Action Buttons (search, approve, update)              │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Service Layer                            │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │ ProductionOrder │  │   BOMService    │  │   MESService    │ │
│  │    Service      │  │                 │  │                 │ │
│  │ - GetOrders()   │  │ - GetBOMTree()  │  │ - LogWorkStart()│ │
│  │ - Approve()     │  │ - GetMachine()  │  │ - GetEntries()  │ │
│  │ - UpdateDates() │  │ - HasBOM()      │  │                 │ │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                          Data Layer                              │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  B1Connection.cs (Singleton)                             │   │
│  │  - SAPbouiCOM.Application (UI)                           │   │
│  │  - SAPbobsCOM.Company (DI)                               │   │
│  │  - ExecuteQuery() / ExecuteQueryToDataTable()            │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      SAP HANA Database                           │
│  OWOR, OCRD, OITM, ORSC, ITT1, OITT, @ATELIERATTN              │
└─────────────────────────────────────────────────────────────────┘
```

---

## Deployment

### 1. Build Release

```
Build → Configuration Manager → Release | x64
Build → Build Solution
```

### 2. Create Addon Registration File (.ard)

```xml
<?xml version="1.0" encoding="UTF-16"?>
<AddOnRegistrationData>
  <AddOnRegistrationDataInner>
    <AddOnDataInner>
      <AddOn>
        <Name>İş Emri Sorgulama</Name>
        <Version>1.0.0</Version>
        <FileName>IsEmriSorgulama.exe</FileName>
        <Supplier>Your Company</Supplier>
        <Description>Production Order Query and MES Integration</Description>
      </AddOn>
    </AddOnDataInner>
  </AddOnRegistrationDataInner>
</AddOnRegistrationData>
```

### 3. Register Addon in SAP B1

1. Administration → Add-Ons → Add-On Administration
2. Register Add-On → Browse to .ard file
3. Assign to company
4. Set startup mode (Manual/Automatic)

### 4. Debug Mode

For development, run the addon from Visual Studio:
1. Start SAP B1 and login
2. Set Visual Studio as x64
3. F5 to start debugging
4. Addon connects to running SAP B1 instance

---

## References

- [SAP Business One SDK Help](https://help.sap.com/docs/SAP_BUSINESS_ONE)
- [SAP Community - B1 Development](https://community.sap.com/topics/business-one)
- [ITCO Addon Framework](https://github.com/ITCompaniet/ITCO-SBO-Addon-Framework)
- [Simple SAP B1 Addon Tutorial](https://blogs.sap.com/2017/08/03/simple-sap-b1-add-on-for-beginners/)
