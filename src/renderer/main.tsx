import { createRoot } from 'react-dom/client';
import '../index.css';
import { App } from './App';
import './globals';

const root = document.getElementById('root');
if (!root) {
  throw new Error('缺少 #root');
}

createRoot(root).render(<App />);
