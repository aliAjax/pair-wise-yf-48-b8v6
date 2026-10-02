import { createRouter, createWebHashHistory } from "vue-router";
import ScoreView from "../views/ScoreView.vue";
import LedgerView from "../views/LedgerView.vue";
import ResultView from "../views/ResultView.vue";
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", component: ScoreView },
    { path: "/ledger", component: LedgerView },
    { path: "/results", component: ResultView }
  ]
});
