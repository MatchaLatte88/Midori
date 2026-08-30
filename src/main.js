import { createApp } from 'vue';
import App from './App.vue';
import { vHint } from './hints.js';
import './styles/base.css';

createApp(App)
  .directive('hint', vHint)
  .mount('#app');
