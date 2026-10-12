# omp-subagent-guard

一個 [oh-my-pi](https://github.com/can1357/oh-my-pi)（omp）擴充套件，讓你設下的限制跟著 agent 派出去的工作走。它把關每一次 `task` 派工（具名負責人、允許且釘選的 agent 定義、派工上限、guard 跟得進隔離副本），重新檢查 subagent 的每一次工具呼叫（工具清單、受保護路徑、每個 agent 各自的寫入範圍，範圍外的寫入送到負責人的畫面上），並寫下稽核紀錄，把每一次派工接到它的 subagent 做了什麼、patch 在哪裡。

[English](README.md)

> **只在 omp 18.2.8 上測過。** 實測（live tests）用腳本化的測試模型，從頭到尾跑真的 omp，另外用真實模型（經 cursor-sdk 擴充的 Claude Opus 5.5）跑過一次。給 omp 18.2.11 與 18.3.2 的部分只用合成事件測過。

## 為什麼

在 omp 裡，subagent 是同一個行程裡新開的一個 session，它有三件事是設計如此：

- **它的工具來自它的 agent 定義，不看主 agent。** 用 `--tools read,task` 啟動的主 agent，可以派出內建的 `task` agent；它沒有工具清單，會拿到預設的 13 個工具，其中有 `write`、`edit`、`bash`、`eval`。
- **它從不問你。** subagent 沒有畫面，omp 就用 `yolo` 模式跑它。omp 的文件寫著：「The parent `task` approval is the authorization boundary.」你在「Allow tool: task」按下允許，就替 subagent 之後做的每一件事簽了名。
- **只要 agent 定義列了工具、而且不全是唯讀工具，omp 就會替 subagent 補上 `hub`。** `hub` 的 `op: "start"` 可以帶任何參數啟動任何程式。在一場沒有掛這個 guard 的實測裡，一個定義只列 `read`、`grep`、`glob`、`find`、`write`、`edit` 的 subagent，透過 `hub` 執行了 `bash -c "echo probe > canary.txt"`，canary 檔真的出現了。

跟得過去的是擴充套件：omp 會把每一個已載入的擴充重新綁到每一個 subagent session 上，而且它的 `tool_call` 比 omp 的核准閘門先跑。所以對 subagent，唯一靠得住的限制是「直接擋」。這個套件就是那道限制。

## 做什麼

| 時機 | 在哪裡 | guard 做什麼 |
|---|---|---|
| 這次 run 開始 | 主 session，`session_start` | 讀設定、確定這次 run 的負責人、開稽核紀錄，並用 omp 自己的 discovery 解析每一個允許的 agent。agent 被蓋掉、權限太寬，或沒有負責人時，告訴你。 |
| 主 agent 呼叫 `task` | 主 session，`tool_call` | 在 omp 問「Allow tool: task」之前就拒絕派工，情況有：這次 run 沒有具名負責人；某一項沒寫 agent，或寫的 agent 不在允許清單；某一項替 subagent 帶了 eval 定義的 `tools`；實際用到的 agent 定義不是釘選的那個檔（例如專案 `.omp/agents/` 裡的同名檔）、沒有工具清單、列了 subagent 工具清單以外的工具，或可以再派工；派工是 isolated，而某個 guard 檔放在專案裡被 git 忽略的位置；會超過這次 run 的派工上限。拒絕理由只說擋了什麼，不說怎麼關掉規則。 |
| omp 派工（18.2.11 起） | 主 session，`before_subagent_spawn` | 拒絕不是經 `task` 工具來的派工（eval 的 `agent()`、workpool）、不在允許清單的 agent、超過上限的派工，以及從 subagent 裡發出的任何派工。handler 自己出錯也一律拒絕。 |
| subagent 起來 | subagent，`session_start` | 認出這是 subagent（omp 18.3.2 起看 `ctx.agent`；18.2.8 看 omp 寫的 `session_init` 紀錄），記下它的 id、agent、父 session、工作目錄的類別與工具。agent 不在允許清單的 subagent（例如 18.2.8 上由 eval `agent()` 開出來的），或是在上限用完之後才起來的 subagent，它的每一次呼叫都拒絕。 |
| subagent 的每一次工具呼叫 | subagent，`tool_call` | 拒絕 subagent 工具清單以外的工具；`hub` 只准拿來傳訊息與查看（`list`、`inbox`、`wait`、`jobs`、`ps`、`logs`、`describe`，以及 `send` 給某個 agent），不准啟動或操作行程。`write`、`edit`、`ast_edit` 寫到受保護路徑就拒絕。寫在 agent 的 `writeScope` 裡的放行。其他寫入送到主 session 的畫面上問負責人：按 Allow 才寫；按 Deny、`askTimeoutMs` 內沒回、沒有畫面或出錯，都拒絕。 |
| `task` 呼叫回來 | 主 session，`tool_result` | 記下每個 subagent 的結果 id、結束碼與 patch 路徑，接到回報過的那個 subagent。從沒回報過的 subagent 等於沒有 guard 在跑：會告訴你，並附上它的 patch 路徑。 |
| 負責人在「Allow tool: task」按 Deny | 主 session，`tool_approval_resolved` | 把這次呼叫預留的派工名額放回去。 |

guard 自己在檢查時出錯，這次呼叫就拒絕。`tool_call` handler 丟錯或超過 30 秒，omp 也會拒絕這次呼叫。

### 受保護路徑

這次 run 裡不論主 session 或 subagent，都不能寫：

- session 工作目錄裡任何一層的 `.env`、`.env.*`、`.envrc`、`.git/`、`.omp/`，以及其他地方名為 `.env`、`.env.*`、`.envrc` 的檔案；
- `~/.omp/`，但 isolated subagent 自己工作的隔離副本（`~/.omp/wt/…`）除外；
- 這個套件、它的設定資料夾、稽核紀錄資料夾，以及載入它的那個檔；
- `protect` 裡的 glob，相對於工作目錄。

路徑會經過 `~`、`$HOME`、`..` 與符號連結去解析。被拒絕的寫入會收到 `Path "<路徑>" is protected`。

### 範圍外的寫入

寫到 agent 的 `writeScope` 以外的檔案，會在主 session 的畫面上問負責人，畫面上有負責人、agent 與它的 id、工具和路徑。omp 給 `tool_call` handler 30 秒，而借用主 session 畫面開的對話框不會暫停 subagent 的計時，所以 `askTimeoutMs` 最多 25 秒（預設 20 秒）。實測時，一次沒人回應的寫入在 20.0 秒後被拒絕。

## 需求

- omp 18.2.8（測過）。在新版上也能載入，`before_subagent_spawn` 與 `ctx.agent` 存在時就會用；這部分沒有測過。
- [Bun](https://bun.sh) 1.3.14 或更新（以 1.4.2 測過）。

## 安裝與啟動

1. clone 到 agent 處理的所有專案**以外**的地方，讓 agent 改不到 guard：

   ```bash
   git clone <這個 repository> ~/omp-subagent-guard
   cd ~/omp-subagent-guard && bun install
   ```

   擴充執行時不需要任何相依套件；`bun install` 是給測試與 CLI 用的。

2. 寫 `~/.config/omp-subagent-guard/config.json`（見 [`examples/config.example.json`](examples/config.example.json)）。你一定要設的只有每個 agent 的 `writeScope`。

3. 在你要工作的專案裡檢查一次設定：

   ```bash
   bun ~/omp-subagent-guard/bin/omp-subagent-guard.ts preflight --overlay ~/omp-subagent-guard/examples/overlay.yml --isolation
   ```

4. 啟動 omp：帶上 guard、overlay、具名負責人，主 agent 只能讀和派工：

   ```bash
   omp -e ~/omp-subagent-guard --config ~/omp-subagent-guard/examples/overlay.yml \
     --subagent-owner alice --tools read,task --approval-mode always-ask
   ```

   用 `-e` 載入這個套件，omp 也會找到它的 `agents/scoped-worker.md`。

5. 讓主 agent 派工給 `scoped-worker`。把「Allow tool: task」當成一次高權限的核准：它替 subagent 的工作簽名。做完之後執行 `/subagents`（只給你看，不會送給模型），每一個 patch 都看過才合併。

## 設定

`~/.config/omp-subagent-guard/config.json`，或 `--subagent-guard-config` 指定的檔案。不會從專案或環境變數讀任何設定。檔案不存在就用預設值；檔案無效會在 session 開始時告訴你，修好之前每一次派工都拒絕。

| 設定 | 預設 | 意思 |
|---|---|---|
| `owner` | 無 | 這次 run 的具名負責人。`--subagent-owner <名字>` 優先。沒有負責人時，每一次派工都拒絕。 |
| `maxSpawns` | `3` | 一次 run 最多能起幾個 subagent。`task` 呼叫要求派工時算一次，subagent 起來時也算。 |
| `agents` | `{ "scoped-worker": {} }` | 主 agent 可以派的 agent。每一個有 `definition`，也就是這個 agent 必須解析到的檔案（預設：這個套件的 `agents/<名字>.md`），以及 `writeScope`，相對於 subagent 工作目錄、不必問就能寫的 glob（預設：沒有，所以每一次寫入都要問）。 |
| `subagentTools` | `read`、`grep`、`glob`、`find`、`write`、`edit`、`yield`、`hub` | subagent 可以呼叫的工具。允許的 agent，它的定義只能列這些。 |
| `protect` | `[]` | 更多受保護的 glob，相對於工作目錄。 |
| `askOutsideScope` | `true` | 設成 `false` 時，範圍外的寫入不問就拒絕。 |
| `askTimeoutMs` | `20000` | 負責人有多少時間回答，100 到 25000。 |
| `auditDir` | `~/.local/state/omp-subagent-guard/audit` | 每次 run 一個 JSONL 檔，以主 session 的 id 命名。 |

## scoped-worker agent

[`agents/scoped-worker.md`](agents/scoped-worker.md) 列了 `read`、`grep`、`glob`、`find`、`write`、`edit`，沒有 `spawns`；`find` 要開了 `find.enabled` omp 才會給。omp 派它出去時會另外補上 `yield` 與 `hub`。要釘選你自己的 agent，就把它和它的 `definition` 加進 `agents`；只要 omp 把這個名字解析到別的檔案，guard 就拒絕。專案 `.omp/agents/` 裡的同名檔就是這樣搶走一個 agent 的（專案層的定義排在使用者層前面）。

## overlay

[`examples/overlay.yml`](examples/overlay.yml) 用 `--config` 載入，裡面的規則就算沒載入 guard，也會跟著每一個 subagent：`bash`、`eval`、`hub` 設成 `prompt`（subagent 的 prompt 會立刻被拒，訊息是「requires approval but no interactive UI available」）、`task.maxRecursionDepth: 1`、一個 `task.maxRuntimeMs` 上限，以及 `task.isolation.apply: false`，讓 isolated subagent 的 patch 留下來等你審，不自動套回。omp 會把 `--config` 疊在全域與專案設定之上。

## 稽核紀錄與審查

每一筆紀錄都帶著 run（主 session 的 id）、session，subagent 的紀錄再帶它的 id 與 agent。事件有 `run_start`、`spawn_request`、`spawn_event`、`spawn_denied_by_owner`、`subagent_start`、`tool_call`（工具、路徑、決定、理由）、`tool_result`、`task_result`（結果 id、結束碼、patch 路徑）與 `unguarded_subagent`。不記檔案內容，也不記派工內容。

- 在 omp 裡執行 `/subagents`，可以看到這次 run：每一次派工、它起了哪些 subagent、哪些呼叫被拒、patch 在哪裡。
- `bun bin/omp-subagent-guard.ts report <audit.jsonl>` 對任何一份紀錄印出同樣的報告；加 `--json` 輸出給程式讀的格式。

subagent 的結果 id 就是它的 session 檔名，所以要把派工接到 subagent，session 必須存檔；用 `--no-session` 時，接不起來，也不會有「沒有 guard 在跑」的警告。

## preflight

```bash
bun bin/omp-subagent-guard.ts preflight [--cwd DIR] [--config FILE] [--overlay FILE] [--guard FILE]... [--isolation] [--json]
```

它檢查：設定有效，而且有負責人；每一個允許的 agent，從 `--cwd` 解析時都落在釘選的檔案上，工具清單夠窄；overlay 設了上面那些規則；沒有任何 guard 檔（這個套件，以及任何用 `--guard` 指定、負責載入它的檔案）放在專案裡被 git 忽略的位置。`--isolation` 會照 omp 的做法建一份隔離副本，確認專案裡的 guard 檔都在副本裡。沒有失敗就以 0 結束，有檢查失敗以 1 結束，用法錯誤以 2 結束。

## 測試

```bash
bun run test
```

`bun run test` 會用暫存的 `HOME` 與 `TMPDIR` 啟動 Bun；直接跑 `bun test` 會拒絕執行，因為測試會在家目錄底下寫 agent 定義、隔離副本與稽核紀錄，而 Bun 在啟動時就把家目錄定住了。測試經由 omp 自己的擴充載入器與 runner 載入 guard，不需要網路。

實測用一個只供測試的腳本化模型 provider（`test/scripted-provider.ts`）跑真的 omp；harness 扮演負責人：

```bash
SUBAGENT_GUARD_LIVE=1 OMP_CLI=/path/to/oh-my-pi/packages/coding-agent/src/cli.ts \
SUBAGENT_GUARD_LIVE_OUT=/tmp/subagent-guard-evidence bun run test test/live.test.ts
```

`OMP_BIN=/path/to/omp` 改跑已安裝的 omp。十場實測顯示：沒有 guard 時，內建的 `task` agent 把 `.env` 寫進 checkout，scoped-worker 也能透過 `hub` 啟動指令；有 guard 時，`.env`、`.omp/agents/` 與 `hub start` 都被拒絕，範圍內的寫入照常，範圍外的寫入由負責人的 Allow 與 Deny 決定，沒人回答時 20 秒後拒絕，print 模式因為沒人可問而拒絕，被拒絕的派工根本不會出現「Allow tool: task」，沒有負責人的 run 一個 subagent 都派不出去，在「Allow tool: task」按 Deny 會放回名額，isolated subagent 會載入一份新的 guard，它的 patch 留下而不套回；只用 overlay 時，subagent 的 `bash` 與 `hub` 立刻被拒。

## 公開發布前待辦

- **威脅建模。** 沒做（STRIDE、OWASP LLM Top 10、OWASP Agentic ASI）。
- **資安稽核。** 沒做；guard 沒有經過獨立的對抗式審查。
- **新版 omp。** `before_subagent_spawn`（18.2.11）與 `ctx.agent`（18.3.2）照上游文件處理，只用合成事件測過。
- **互動式 TUI。** 問負責人的對話框只在 RPC 模式與 print 模式測過，沒在終端機介面測過。
- **背景 subagent**（`async.enabled`）。測試都把它關掉。比自己的 `task` 呼叫活得更久的 subagent，它的對話框可能一開就關，結果是拒絕寫入。
- **更多真實模型的場次。** 只跑過一場、一個模型、一個情境。
- **第一次 CI。** GitHub Actions 的 workflow 還沒跑過。

## 限制

- **這不是沙箱。** guard 檢查 `write`、`edit`、`ast_edit` 的路徑，其他工具按名字拒絕。你加進 `subagentTools` 的工具，除了 `hub`，都不檢查路徑就放行。
- **讀取不受限制。** subagent 可以讀 `.env`，再把內容抄進範圍內的檔案。
- **主 session 只檢查寫到受保護路徑。** 主 agent 保持 `--tools read,task`，並保留 overlay 對 `bash`、`eval`、`hub` 的 `prompt` 規則。
- **18.2.8 沒有正式的方法分辨 subagent。** guard 讀的是 omp 的 `session_init` 紀錄，目前只有 omp 的 task executor 會寫；omp 一改就可能失效。在新版 omp 上，advisor 的呼叫會以名為 `advisor` 的 subagent 出現，除非你允許它，否則會被拒絕。
- **omp 的 task 工具會在 session 裡快取 agent discovery。** guard 在 session 開始時與每一次派工時都檢查定義，任一次有問題就拒絕；但定義如果在這兩個時間點之間改掉又改回來，可能看不到。
- **派工上限偏保守。** 一個 `task` 呼叫還在跑時，它預留的名額和它已經起來的 subagent 都會算進去，所以同時發出的另一次派工可能被提早拒絕。
- **agent 改得到的 guard，下一個 session 就可能被改掉。** 請裝在專案以外；guard 會拒絕寫入它自己的資料夾。

## 背景

這個套件實作了一個比較 Cursor 與 omp 的內部威脅系列裡、Day22（subagent）的整合時序圖。那個系列量到：omp 會把擴充綁到每一個 subagent，而且 `tool_call` 比核准閘門先跑；subagent 以 `yolo` 模式執行；isolated subagent 只有在 git 看得到 guard 時才找得到它。`hub` 的缺口，以及這個套件依賴的 18.2.8 行為，是在打造它的過程中讀 omp 18.2.8 原始碼發現的，並在實測裡確認。

## 授權

[MIT](LICENSE)
