package jethub

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

// Loomy 微信扫码登录的**流程状态机**（宿主侧独有）。
//
// 与 raccoon 的「后台 goroutine 轮询 + 页面被动读状态」不同，这里是**页面驱动**
// （与参考实现一致）：页面每轮调一次公开的 poll 端点 → 宿主执行**一次**微信长轮询
// 并推进状态机。这样 `last` 链与 `bind/auth` 的触发点只有一处，不会分裂。
//
// ⚠️ 敏感值（`uuid`/`rcode`/`msgid`/`session`/`userid`）**只存在于宿主侧**，
// 公开端点的响应里绝不出现（与参考实现的边界一致）。

// Flow stages exposed to the login page.
const (
	loomyStageScanning  = "scanning"
	loomyStageScanned   = "scanned"
	loomyStageNeedPhone = "need_phone"
	loomyStageDone      = "done"
	loomyStageCancelled = "cancelled"
	loomyStageExpired   = "expired"
)

// loomyWechatLoginTimeout mirrors ref LOOMY_WECHAT_LOGIN_TIMEOUT_MS (5 分钟):
// 扫码太慢就没必要继续挂着占位账号。
const loomyWechatLoginTimeout = 5 * time.Minute

// LoomyWechatFlow is one in-flight WeChat QR login (guarded; host-side only).
type LoomyWechatFlow struct {
	mu sync.Mutex
	m  *Manager
	// accountID is the placeholder account the completed credential lands on.
	accountID string
	// deadline bounds the whole flow (扫不完就失败，别让占位账号无限挂着)。
	deadline time.Time

	uuid        string
	lastErrcode string

	// stage is the page-visible state machine position.
	stage string
	// errMsg is the page-visible failure reason (stage stays scanning otherwise).
	errMsg string

	// rcode comes from bind/auth and is required by every later step.
	rcode      string
	rcodeKnown bool
	// bind is 1 when WeChat already has a bound phone (⇒ bind/skip).
	bind     int
	nickname string
	// bindMsgid is the sendMsg → checkCode correlation (host-side only).
	bindMsgid string

	settled bool
	result  chan LoginOutcome
}

// StartLoomyWechatLogin fetches the QR uuid and returns the flow. ⚠️ 与参考实现
// 一致：**取不到 uuid 就整个流程起不来**（调用方删占位账号）。
func (m *Manager) StartLoomyWechatLogin(ctx context.Context, accountID string) (*LoomyWechatFlow, error) {
	uuid, err := m.FetchLoomyWechatUUID(ctx, loomyWechatState())
	if err != nil {
		return nil, err
	}
	return &LoomyWechatFlow{
		m: m, accountID: accountID, uuid: uuid, stage: loomyStageScanning,
		deadline: time.Now().Add(loomyWechatLoginTimeout),
		result:   make(chan LoginOutcome, 1),
	}, nil
}

// Result is the outcome channel the login session's pump consumes.
func (f *LoomyWechatFlow) Result() <-chan LoginOutcome { return f.result }

// QRImage mime+bytes for the page (fetched through the per-provider client).
func (f *LoomyWechatFlow) QRImage(ctx context.Context) ([]byte, string, error) {
	f.mu.Lock()
	uuid := f.uuid
	f.mu.Unlock()
	return f.m.FetchLoomyWechatQRImage(ctx, uuid)
}

// Stage reports the page-visible state.
func (f *LoomyWechatFlow) Stage() (stage, errMsg string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.stage, f.errMsg
}

// Poll advances the flow by ONE upstream long-poll. It returns the page-visible
// stage. Terminal conditions settle the flow (cancelled/expired as errors, so
// the placeholder account is deleted and the panel shows a real reason).
func (f *LoomyWechatFlow) Poll(ctx context.Context) (stage, errMsg string) {
	f.mu.Lock()
	if f.stage == loomyStageDone || f.stage == loomyStageCancelled || f.stage == loomyStageExpired {
		st, e := f.stage, f.errMsg
		f.mu.Unlock()
		return st, e
	}
	if !f.deadline.IsZero() && time.Now().After(f.deadline) {
		f.mu.Unlock()
		f.fail("登录超时（5 分钟内未完成），请关闭窗口后重试", loomyStageExpired)
		return f.Stage()
	}
	uuid, last := f.uuid, f.lastErrcode
	f.mu.Unlock()

	status, code, errcode := f.m.PollLoomyWechatOnce(ctx, uuid, last)

	f.mu.Lock()
	if errcode != "" {
		f.lastErrcode = errcode
	}
	f.mu.Unlock()

	switch status {
	case loomyWechatStatusConfirmed:
		if err := f.exchangeCode(ctx, code); err != nil {
			f.fail(fmt.Sprintf("微信授权失败：%v", err), loomyStageExpired)
		}
	case loomyWechatStatusScanned:
		f.mu.Lock()
		f.stage = loomyStageScanned
		f.mu.Unlock()
	case loomyWechatStatusCancelled:
		f.fail("你已取消授权（窗口可以关闭了）", loomyStageCancelled)
	case loomyWechatStatusExpired:
		f.fail("二维码已失效，请关闭窗口后重新发起登录", loomyStageExpired)
	case loomyWechatStatusError:
		// 长轮询偶发失败不终止流程（ref 同款）：留着 scanning 让页面继续。
		f.mu.Lock()
		f.stage = loomyStageScanning
		f.mu.Unlock()
	default:
		f.mu.Lock()
		f.stage = loomyStageScanning
		f.mu.Unlock()
	}
	return f.Stage()
}

// exchangeCode runs bind/auth → (bind/skip | need_phone).
func (f *LoomyWechatFlow) exchangeCode(ctx context.Context, code string) error {
	if code == "" {
		return fmt.Errorf("微信未回传 code")
	}
	auth, err := f.m.BindLoomyThirdAccount(ctx, code)
	if err != nil {
		return err
	}
	f.mu.Lock()
	f.rcode, f.rcodeKnown, f.bind, f.nickname = auth.Rcode, true, auth.Bind, auth.Nickname
	f.mu.Unlock()

	if auth.Bind == 1 {
		// 微信侧已绑手机号 ⇒ 直接换 session 完成登录（phone 为空，ref 同款）。
		res, err := f.m.BindLoomySkip(ctx, auth.Rcode)
		if err != nil {
			return err
		}
		return f.complete(ctx, res.Session, res.UserID, "", auth.Nickname)
	}
	f.mu.Lock()
	f.stage = loomyStageNeedPhone
	f.mu.Unlock()
	return nil
}

// SendBindSms sends the binding SMS code (POST action=send_sms).
// ⚠️ 单步失败**不终止**流程（用户可能只是号码错/验证码输错），由页面就地提示重试。
func (f *LoomyWechatFlow) SendBindSms(ctx context.Context, phone string) error {
	phone = loomyNormalizePhone(phone)
	if phone == "" {
		return fmt.Errorf("请输入有效的 11 位手机号")
	}
	f.mu.Lock()
	rcode, ok := f.rcode, f.rcodeKnown
	f.mu.Unlock()
	if !ok {
		return fmt.Errorf("尚未完成微信扫码，请先扫码")
	}
	msgid, err := f.m.BindLoomySendMsg(ctx, rcode, phone)
	if err != nil {
		return err
	}
	f.mu.Lock()
	f.bindMsgid = msgid
	f.mu.Unlock()
	return nil
}

// VerifyBind verifies the binding code and completes the login
// (POST action=verify_sms).
func (f *LoomyWechatFlow) VerifyBind(ctx context.Context, phone, code string) error {
	phone = loomyNormalizePhone(phone)
	if code == "" {
		return fmt.Errorf("请输入验证码")
	}
	f.mu.Lock()
	rcode, known, msgid := f.rcode, f.rcodeKnown, f.bindMsgid
	f.mu.Unlock()
	if !known {
		return fmt.Errorf("尚未完成微信扫码，请先扫码")
	}
	if msgid == "" {
		return fmt.Errorf("请先获取验证码")
	}
	res, err := f.m.BindLoomyCheckCode(ctx, rcode, code, msgid)
	if err != nil {
		return err
	}
	f.mu.Lock()
	nickname := f.nickname
	f.mu.Unlock()
	bound := res.Phone
	if bound == "" {
		bound = phone
	}
	return f.complete(ctx, res.Session, res.UserID, bound, nickname)
}

// complete persists the credential, names the account and settles the flow.
func (f *LoomyWechatFlow) complete(ctx context.Context, session, userid, phone, nickname string) error {
	if session == "" || userid == "" {
		return fmt.Errorf("登录响应缺少 session/userid")
	}
	cred := &LoomyCredential{
		AccessToken: session,
		UserID:      userid,
		Phone:       phone,
		Nickname:    nickname,
		ExpiresAt:   fmt.Sprintf("%d", nowMillis()+int64(loomySessionTTL)*1000),
	}
	if err := f.m.CompleteLoomyWechatLogin(f.accountID, cred); err != nil {
		return err
	}
	credJSON, _ := json.Marshal(cred)
	f.settle(LoginOutcome{
		CredentialJSON: credJSON,
		ExpiresAt:      LoomyExpiresAtMs(cred),
		Refreshable:    false, // Loomy 没有续期端点
	})
	return nil
}

// fail records a terminal failure (page-visible stage + reason) and settles the
// flow with an error.
//
// ⚠️ 比参考实现更紧一档：参考在 cancelled/expired 时只是让页面停止轮询 —— 流程
// promise 要等到 5 分钟总超时才 reject，那期间占位账号一直挂着。这里立即结算，
// `SettleAndCleanup` 随即删掉占位账号。
func (f *LoomyWechatFlow) fail(msg, stage string) {
	f.mu.Lock()
	if f.settled {
		f.mu.Unlock()
		return
	}
	f.errMsg = msg
	f.stage = stage
	f.mu.Unlock()
	f.settle(LoginOutcome{Err: fmt.Errorf("loomy: %s", msg)})
}

// settle delivers the single outcome exactly once.
func (f *LoomyWechatFlow) settle(out LoginOutcome) {
	f.mu.Lock()
	if f.settled {
		f.mu.Unlock()
		return
	}
	f.settled = true
	if out.Err == nil {
		f.stage = loomyStageDone
	}
	f.mu.Unlock()
	deliver(f.result, out)
}

// loomyNormalizePhone keeps digits only and requires 11 of them (CN mobile).
func loomyNormalizePhone(phone string) string {
	digits := make([]rune, 0, len(phone))
	for _, r := range phone {
		if r >= '0' && r <= '9' {
			digits = append(digits, r)
		}
	}
	if len(digits) != 11 {
		return ""
	}
	return string(digits)
}

// CompleteLoomyWechatLogin persists a WeChat-path credential and names the
// account: 微信 nickname → `Loomy {手机尾4}` → accountID (与 ref jet-hub-rpc.ts
// 的昵称策略一致；⚠️ bind/skip 路径没有手机号，故必须有最后一级回退，否则会
// 得到一个字面为「Loomy 」的昵称)。
func (m *Manager) CompleteLoomyWechatLogin(accountID string, cred *LoomyCredential) error {
	acc, ok := m.FindAccount(accountID)
	if !ok {
		return ErrNotFound
	}
	credJSON, err := json.Marshal(cred)
	if err != nil {
		return err
	}
	if err := m.SetCredential(acc.Provider, acc.CredentialRef, credJSON, LoomyExpiresAtMs(cred), false); err != nil {
		return err
	}
	name := firstNonEmpty(cred.Nickname, loomyWechatAccountName(cred.Phone), accountID)
	_ = m.UpdateAccount(accountID, func(a *Account) {
		a.Nickname = name
		a.Refreshable = false
	})
	// best-effort 初始化每日额度（登录后官方也立即调用；失败只 warn，不影响登录）。
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if _, err := m.ClaimLoomyDaily(ctx, accountID); err != nil {
		if m.logger != nil {
			m.logger.Warn("[jethub] loomy 登录后初始化每日额度失败（不影响登录）：%v", err)
		}
	}
	return nil
}

// loomyWechatAccountName renders the fallback account name from the phone.
func loomyWechatAccountName(phone string) string {
	tail := loomyPhoneTail(phone)
	if tail == "" {
		return ""
	}
	return "Loomy " + tail
}
