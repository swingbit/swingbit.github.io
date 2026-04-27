import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';

const renderMermaid = async () => {
  const codeBlocks = document.querySelectorAll('.language-mermaid');
  
  for (const block of codeBlocks) {
    const code = block.innerText;
    const container = document.createElement('div');
    container.className = 'mermaid';
    container.textContent = code;
    
    const wrapper = block.closest('.highlighter-rouge') || block.closest('pre') || block;
    wrapper.replaceWith(container);
  }
  
  mermaid.initialize({ 
    startOnLoad: false, 
    theme: 'dark',
    securityLevel: 'loose' 
  });
  await mermaid.run();
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', renderMermaid);
} else {
  renderMermaid();
}
