(() => {
  if (window.HexiGridBootGeometry) return;
  const PHI = (1 + Math.sqrt(5)) / 2;
  const rawVertices = [
    [-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0],
    [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI],
    [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1]
  ];
  const rawFaces = [
    [0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],
    [1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],
    [3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],
    [4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]
  ];
  const vertices = rawVertices.map((vertex) => {
    const length = Math.hypot(...vertex);
    return Object.freeze(vertex.map((value) => value / length));
  });
  const faces = rawFaces.map((face) => Object.freeze(face));
  const faceCenters = faces.map((face) => Object.freeze(face.reduce((sum, index) => {
    sum[0] += vertices[index][0] / 3;
    sum[1] += vertices[index][1] / 3;
    sum[2] += vertices[index][2] / 3;
    return sum;
  }, [0, 0, 0])));
  const edges = [];
  for (let from = 0; from < vertices.length; from += 1) {
    for (let to = from + 1; to < vertices.length; to += 1) {
      const distance = Math.hypot(
        vertices[from][0] - vertices[to][0],
        vertices[from][1] - vertices[to][1],
        vertices[from][2] - vertices[to][2]
      );
      if (distance < 1.08) edges.push(Object.freeze([from, to]));
    }
  }
  window.HexiGridBootGeometry = Object.freeze({
    vertices: Object.freeze(vertices),
    faces: Object.freeze(faces),
    faceCenters: Object.freeze(faceCenters),
    edges: Object.freeze(edges)
  });
})();
