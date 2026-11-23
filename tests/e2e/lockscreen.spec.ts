import { expect, test } from '@playwright/test';

test.describe('前端九宫格安全门禁与 3D 翻转小丑动效', () => {
  test.beforeEach(async ({ page }) => {
    // 确保每个测试从初始锁定状态开始
    await page.addInitScript(() => {
      sessionStorage.removeItem('cyberlab.unlocked');
      localStorage.removeItem('cyberlab.unlocked');
    });
  });

  test('初始加载处于强阻断门禁状态，严禁访问主站业务', async ({ page }) => {
    let cloudCalls = 0;
    await page.route('**/api/**', async (route) => {
      cloudCalls++;
      await route.abort();
    });

    await page.goto('/');

    const lockScreen = page.locator('#lab-lock-screen');
    await expect(lockScreen).toBeVisible();
    await expect(lockScreen).not.toHaveClass(/is-hidden/);

    // 主站 shell 挂载 inert 强阻断
    const appShell = page.locator('#lab-app');
    await expect(appShell).toHaveAttribute('inert', '');

    // 严禁向后端发起任何数据请求
    expect(cloudCalls).toBe(0);

    // 检查九宫格小键盘与 4 位圆点掩码指示器
    const dots = page.locator('#lab-lock-dots .lab-lock-dot');
    await expect(dots).toHaveCount(4);
    for (let i = 0; i < 4; i++) {
      await expect(dots.nth(i)).not.toHaveClass(/is-active/);
    }

    // 检查数字按键
    for (let num = 0; num <= 9; num++) {
      await expect(page.locator(`.lab-key[data-key="${num}"]`)).toBeVisible();
    }
    await expect(page.locator('.lab-key[data-key="clear"]')).toBeVisible();
    await expect(page.locator('.lab-key[data-key="backspace"]')).toBeVisible();
  });

  test('输错密码时卡片沿 Y 轴平滑 3D 翻转至纯图小丑', async ({ page }) => {
    await page.goto('/');

    const flipper = page.locator('#lab-card-flipper');
    await expect(flipper).not.toHaveClass(/is-flipped/);

    // 依次点击错误密码 1, 2, 3, 4
    await page.locator('.lab-key[data-key="1"]').click();
    await page.locator('.lab-key[data-key="2"]').click();
    await page.locator('.lab-key[data-key="3"]').click();
    await page.locator('.lab-key[data-key="4"]').click();

    // 输错后卡片应翻转到背面
    await expect(flipper).toHaveClass(/is-flipped/);

    // 背面小丑展示区检查：纯图小丑，严禁任何文字或按钮
    const clownBack = page.locator('#lab-clown-back');
    await expect(clownBack).toBeVisible();
    const clownText = await clownBack.innerText();
    expect(clownText.trim()).toBe('');

    const clownSvg = clownBack.locator('.lab-clown-art');
    await expect(clownSvg).toBeVisible();
  });

  test('直接点击小丑图片顺时针同向回旋 360° 复原正面并清空密码', async ({ page }) => {
    await page.goto('/');

    const flipper = page.locator('#lab-card-flipper');
    const clownBack = page.locator('#lab-clown-back');

    // 输入错误密码 9, 9, 9, 9 触发翻转
    await page.locator('.lab-key[data-key="9"]').click();
    await page.locator('.lab-key[data-key="9"]').click();
    await page.locator('.lab-key[data-key="9"]').click();
    await page.locator('.lab-key[data-key="9"]').click();
    await expect(flipper).toHaveClass(/is-flipped/);

    // 直接点击小丑图片本身
    await clownBack.click();

    // 应当顺时针同向回旋 (is-returning)，然后重置回正面
    await expect(flipper).not.toHaveClass(/is-flipped/);
    await expect(flipper).not.toHaveClass(/is-returning/);

    // 验证密码已自动清空，指示器恢复未激活状态
    const dots = page.locator('#lab-lock-dots .lab-lock-dot');
    for (let i = 0; i < 4; i++) {
      await expect(dots.nth(i)).not.toHaveClass(/is-active/);
    }
  });

  test('输入正确密码 2580 解锁成功进入工作台', async ({ page }) => {
    await page.goto('/');

    const flipper = page.locator('#lab-card-flipper');
    const lockScreen = page.locator('#lab-lock-screen');
    const appShell = page.locator('#lab-app');

    // 依次点击正确密码 2, 5, 8, 0
    await page.locator('.lab-key[data-key="2"]').click();
    await page.locator('.lab-key[data-key="5"]').click();
    await page.locator('.lab-key[data-key="8"]').click();
    await page.locator('.lab-key[data-key="0"]').click();

    // 验证指示器高亮且门禁隐藏
    await expect(lockScreen).toHaveClass(/is-hidden/);
    await expect(flipper).not.toHaveClass(/is-flipped/);

    // 主站 app 移除 inert
    await expect(appShell).not.toHaveAttribute('inert');

    // sessionStorage 中记录已解锁
    const isUnlocked = await page.evaluate(() => sessionStorage.getItem('cyberlab.unlocked'));
    expect(isUnlocked).toBe('1');
  });

  test('全局顶栏锁定工作台按钮可重新切回初始门禁', async ({ page }) => {
    // 预置已解锁状态访问页面
    await page.addInitScript(() => {
      sessionStorage.setItem('cyberlab.unlocked', '1');
      localStorage.setItem('cyberlab.unlocked', '1');
    });

    await page.goto('/');

    const lockScreen = page.locator('#lab-lock-screen');
    await expect(lockScreen).toHaveClass(/is-hidden/);

    const lockBtn = page.locator('#lab-lock-btn');
    await expect(lockBtn).toBeVisible();

    // 点击锁定按钮
    await lockBtn.click();

    // 门禁重新显示，appShell 重新挂载 inert
    await expect(lockScreen).not.toHaveClass(/is-hidden/);
    const appShell = page.locator('#lab-app');
    await expect(appShell).toHaveAttribute('inert', '');

    // 存储状态均已清除
    const isUnlocked = await page.evaluate(() => sessionStorage.getItem('cyberlab.unlocked') || localStorage.getItem('cyberlab.unlocked'));
    expect(isUnlocked).toBeNull();
  });
});
