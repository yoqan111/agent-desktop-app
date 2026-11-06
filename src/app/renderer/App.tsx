import { useState, type ReactElement } from 'react';
import { MediaWorkspace } from '../../features/media/renderer';
import { PlaywrightStudio } from '../../features/playwright-studio/renderer';

type ProductMode = 'media' | 'playwright';

/** App shell: product-mode switcher only. Feature UIs live under features/<name>/renderer. */
export function App(): ReactElement {
  const [productMode, setProductMode] = useState<ProductMode>('media');

  if (productMode === 'playwright') {
    return <PlaywrightStudio onBack={() => setProductMode('media')} />;
  }

  return <MediaWorkspace onOpenPlaywright={() => setProductMode('playwright')} />;
}
