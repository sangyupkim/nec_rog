# Project Patchwork

텍스트 UI 기반 커맨드 턴제 로그라이트. 네크로맨서가 되어 몬스터 부속으로 누더기 골렘을 조립한다.

## 실행

```
npm start        # http://localhost:5173
```

ES 모듈과 JSON 로딩 때문에 `index.html`을 직접 열면 동작하지 않는다. 반드시 위 명령으로 띄운다.

## 점검

```
npm run check      # 데이터 참조 무결성 + 밸런스
npm run validate   # 참조 무결성만
npm run balance    # 턴수 목표 · 층 누적 소모
```

## 구조

| 경로 | 내용 |
|---|---|
| `docs/GDD.md` | 기획서 |
| `data/*.json` | 모든 게임 콘텐츠 (코드 수정 없이 추가 가능) |
| `src/core.js` | 데이터 로딩 · 난수 · 골렘 조립 · 데미지 공식 |
| `src/combat.js` | 커맨드 턴제 전투 엔진 (DOM 무관) |
| `src/dungeon.js` | 시드 기반 층 생성 |
| `src/town.js` | 마을 — 의뢰 · 상점 · 대장간 · 조합 |
| `src/ui.js` | 2분할 화면 그리기 |
| `src/main.js` | 진행 · 화면 전환 · 세이브 |
| `tools/` | 검증기 · 밸런스 점검기 · 개발 서버 |

세이브는 `localStorage`에 저장된다.
